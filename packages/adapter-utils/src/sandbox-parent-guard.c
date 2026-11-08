#define NAPI_VERSION 8
#include <node_api.h>
#include <uv.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#define MAX_PATH_BYTES 12289
#define MAX_ANCESTORS 8

typedef enum {
  GUARD_PRE_COPY,
  GUARD_POST_COPY,
} guard_operation;

typedef enum {
  GUARD_PHASE_SUCCESS,
  GUARD_PHASE_ANCESTOR,
  GUARD_PHASE_LEAF,
  GUARD_PHASE_ROOT,
  GUARD_PHASE_COMPLETION,
} guard_phase;

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  char *path;
  size_t offsets[MAX_ANCESTORS];
  size_t depth;
  size_t leaf_offset;
  size_t root_offset;
  size_t failing_path_offset;
  guard_operation operation;
  guard_phase phase;
  int status;
  int non_directory;
  int root_changed;
  double source_dev;
  double source_ino;
  double mode;
  int kind;
} guard_work;

static void abort_napi_failure(const char *message) {
  napi_fatal_error("sandbox-parent-guard", NAPI_AUTO_LENGTH, message, NAPI_AUTO_LENGTH);
}

static napi_value throw_error_if_clear(napi_env env, const char *message) {
  bool pending = false;
  napi_status status = napi_is_exception_pending(env, &pending);
  if (status != napi_ok) abort_napi_failure("unable to inspect pending exception");
  if (!pending) {
    status = napi_throw_error(env, NULL, message);
    if (status != napi_ok) abort_napi_failure("unable to throw sandbox parent guard error");
  }
  return NULL;
}

static napi_value throw_type_error_if_clear(napi_env env, const char *message) {
  bool pending = false;
  napi_status status = napi_is_exception_pending(env, &pending);
  if (status != napi_ok) abort_napi_failure("unable to inspect pending exception");
  if (!pending) {
    status = napi_throw_type_error(env, NULL, message);
    if (status != napi_ok) abort_napi_failure("unable to throw sandbox parent guard type error");
  }
  return NULL;
}

static napi_value throw_range_error_if_clear(napi_env env, const char *message) {
  bool pending = false;
  napi_status status = napi_is_exception_pending(env, &pending);
  if (status != napi_ok) abort_napi_failure("unable to inspect pending exception");
  if (!pending) {
    status = napi_throw_range_error(env, NULL, message);
    if (status != napi_ok) abort_napi_failure("unable to throw sandbox parent guard range error");
  }
  return NULL;
}

static int take_pending_exception(napi_env env, napi_value *exception) {
  bool pending = false;
  napi_status status = napi_is_exception_pending(env, &pending);
  if (status != napi_ok) abort_napi_failure("unable to inspect pending completion exception");
  if (!pending) return 0;
  status = napi_get_and_clear_last_exception(env, exception);
  if (status != napi_ok) abort_napi_failure("unable to retain pending completion exception");
  return 1;
}

static int make_failure_reason(napi_env env, napi_value *reason) {
  napi_value exception = NULL;
  if (take_pending_exception(env, &exception)) {
    *reason = exception;
    return 1;
  }

  napi_value message = NULL;
  napi_status status = napi_create_string_utf8(env, "sandbox parent guard completion failed", NAPI_AUTO_LENGTH, &message);
  if (status == napi_ok) {
    napi_value error = NULL;
    status = napi_create_error(env, NULL, message, &error);
    if (status == napi_ok) {
      *reason = error;
      return 1;
    }
  }

  if (take_pending_exception(env, &exception)) {
    *reason = exception;
    return 1;
  }
  napi_value undefined = NULL;
  status = napi_get_undefined(env, &undefined);
  if (status != napi_ok) return 0;
  *reason = undefined;
  return 1;
}

static void reject_deferred_or_fatal(napi_env env, napi_deferred deferred, napi_value reason) {
  napi_status status = napi_reject_deferred(env, deferred, reason);
  if (status == napi_ok) return;

  napi_value exception = NULL;
  if (take_pending_exception(env, &exception)) {
    status = napi_reject_deferred(env, deferred, exception);
    if (status == napi_ok) return;
  }

  napi_value ignored_exception = NULL;
  take_pending_exception(env, &ignored_exception);
  napi_value undefined = NULL;
  status = napi_get_undefined(env, &undefined);
  if (status != napi_ok) abort_napi_failure("unable to create final promise rejection value");
  status = napi_reject_deferred(env, deferred, undefined);
  if (status != napi_ok) abort_napi_failure("unable to settle sandbox parent guard promise");
}

static void delete_async_work_or_fatal(napi_env env, napi_async_work work) {
  napi_status status = napi_delete_async_work(env, work);
  if (status != napi_ok) abort_napi_failure("unable to release sandbox parent guard async work");
}

static napi_value reject_prequeue_failure(napi_env env, guard_work *request, napi_value promise, const char *message, bool has_work) {
  napi_value reason = NULL;
  if (!take_pending_exception(env, &reason)) {
    napi_value text = NULL;
    napi_status status = napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &text);
    if (status == napi_ok) status = napi_create_error(env, NULL, text, &reason);
    if (status != napi_ok && !make_failure_reason(env, &reason)) {
      abort_napi_failure("unable to construct sandbox parent guard rejection");
    }
  }
  if (has_work) delete_async_work_or_fatal(env, request->work);
  reject_deferred_or_fatal(env, request->deferred, reason);
  free(request->path);
  free(request);
  return promise;
}

static int lstat_at(guard_work *request, size_t offset, uv_stat_t *statbuf) {
  uv_fs_t fs_request;
  memset(&fs_request, 0, sizeof(fs_request));
  char saved = request->path[offset];
  request->path[offset] = '\0';
  int result = uv_fs_lstat(uv_default_loop(), &fs_request, request->path, NULL);
  request->path[offset] = saved;
  if (result >= 0) *statbuf = fs_request.statbuf;
  uv_fs_req_cleanup(&fs_request);
  return result;
}

static int inspect_ancestors(guard_work *request) {
  for (size_t i = 0; i < request->depth; i++) {
    uv_stat_t statbuf;
    int result = lstat_at(request, request->offsets[i], &statbuf);
    if (result < 0) {
      request->phase = GUARD_PHASE_ANCESTOR;
      request->status = result;
      request->failing_path_offset = request->offsets[i];
      return 0;
    }
    if (!S_ISDIR(statbuf.st_mode)) {
      request->phase = GUARD_PHASE_ANCESTOR;
      request->non_directory = 1;
      request->failing_path_offset = request->offsets[i];
      return 0;
    }
  }
  return 1;
}

static void complete_pass(napi_env env, void *data) {
  (void)env;
  guard_work *request = (guard_work *)data;
  if (request->operation == GUARD_PRE_COPY) {
    if (!inspect_ancestors(request)) return;
    uv_stat_t statbuf;
    int result = lstat_at(request, request->leaf_offset, &statbuf);
    if (result < 0) {
      request->phase = GUARD_PHASE_LEAF;
      request->status = result;
      request->failing_path_offset = request->leaf_offset;
      return;
    }
    request->mode = (double)statbuf.st_mode;
    request->kind = S_ISDIR(statbuf.st_mode) ? 1 : S_ISLNK(statbuf.st_mode) ? 2 : 0;
    return;
  }

  uv_stat_t root_stat;
  int result = lstat_at(request, request->root_offset, &root_stat);
  if (result < 0) {
    request->phase = GUARD_PHASE_ROOT;
    request->status = result;
    request->failing_path_offset = request->root_offset;
    return;
  }
  if (!S_ISDIR(root_stat.st_mode) || (double)root_stat.st_dev != request->source_dev ||
      (double)root_stat.st_ino != request->source_ino) {
    request->phase = GUARD_PHASE_ROOT;
    request->non_directory = !S_ISDIR(root_stat.st_mode);
    request->root_changed = 1;
    request->failing_path_offset = request->root_offset;
    return;
  }
  (void)inspect_ancestors(request);
}

static napi_status set_named(napi_env env, napi_value object, const char *name, napi_value value) {
  return napi_set_named_property(env, object, name, value);
}

static napi_status make_result(napi_env env, guard_work *request, napi_value *output) {
  napi_value result = NULL;
  napi_value value = NULL;
  napi_status status = napi_create_object(env, &result);
  if (status != napi_ok) return status;
  const char *phase = request->phase == GUARD_PHASE_ANCESTOR ? "ancestor" :
      request->phase == GUARD_PHASE_LEAF ? "leaf" :
      request->phase == GUARD_PHASE_ROOT ? "root" :
      request->phase == GUARD_PHASE_COMPLETION ? "completion" : "success";
  status = napi_create_string_utf8(env, phase, NAPI_AUTO_LENGTH, &value);
  if (status != napi_ok || (status = set_named(env, result, "phase", value)) != napi_ok) return status;
#define SET_INT_PROPERTY(name, number) do { \
  status = napi_create_int32(env, (number), &value); \
  if (status != napi_ok || (status = set_named(env, result, (name), value)) != napi_ok) return status; \
} while (0)
  SET_INT_PROPERTY("status", request->status);
  SET_INT_PROPERTY("kind", request->kind);
  SET_INT_PROPERTY("pathOffset", (int32_t)request->failing_path_offset);
  SET_INT_PROPERTY("pathLength", (int32_t)request->failing_path_offset);
#undef SET_INT_PROPERTY
  status = napi_create_double(env, request->mode, &value);
  if (status != napi_ok || (status = set_named(env, result, "mode", value)) != napi_ok) return status;
  status = napi_get_boolean(env, request->non_directory, &value);
  if (status != napi_ok || (status = set_named(env, result, "nonDirectory", value)) != napi_ok) return status;
  status = napi_get_boolean(env, request->root_changed, &value);
  if (status != napi_ok || (status = set_named(env, result, "rootChanged", value)) != napi_ok) return status;
  if (request->phase == GUARD_PHASE_ANCESTOR || request->phase == GUARD_PHASE_LEAF || request->phase == GUARD_PHASE_ROOT) {
    status = napi_create_string_utf8(env, request->path, request->failing_path_offset, &value);
    if (status != napi_ok || (status = set_named(env, result, "path", value)) != napi_ok) return status;
  }
  if (request->status < 0) {
    status = napi_create_string_utf8(env, uv_err_name(request->status), NAPI_AUTO_LENGTH, &value);
    if (status != napi_ok || (status = set_named(env, result, "code", value)) != napi_ok) return status;
    status = napi_create_string_utf8(env, uv_strerror(request->status), NAPI_AUTO_LENGTH, &value);
    if (status != napi_ok || (status = set_named(env, result, "message", value)) != napi_ok) return status;
  }
  *output = result;
  return napi_ok;
}

static void finish_work(napi_env env, napi_status completion_status, void *data) {
  guard_work *request = (guard_work *)data;
  if (completion_status != napi_ok) {
    request->phase = GUARD_PHASE_COMPLETION;
    request->status = UV_ECANCELED;
  }

  napi_value result = NULL;
  napi_status status = make_result(env, request, &result);
  if (status == napi_ok) status = napi_resolve_deferred(env, request->deferred, result);
  if (status != napi_ok) {
    napi_value reason = NULL;
    if (!make_failure_reason(env, &reason)) abort_napi_failure("unable to construct sandbox parent guard rejection");
    reject_deferred_or_fatal(env, request->deferred, reason);
  }

  delete_async_work_or_fatal(env, request->work);
  free(request->path);
  free(request);
}

static napi_value start_guard(napi_env env, napi_callback_info info, guard_operation operation) {
  size_t argc = operation == GUARD_PRE_COPY ? 2 : 4;
  napi_value argv[4];
  napi_status status = napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (status != napi_ok || argc != (operation == GUARD_PRE_COPY ? 2u : 4u)) {
    return throw_type_error_if_clear(env, "sandbox parent guard received malformed arguments");
  }

  napi_valuetype path_type, depth_type;
  status = napi_typeof(env, argv[0], &path_type);
  if (status != napi_ok) return throw_error_if_clear(env, "sandbox parent guard path inspection failed");
  status = napi_typeof(env, argv[1], &depth_type);
  if (status != napi_ok) return throw_error_if_clear(env, "sandbox parent guard depth inspection failed");
  if (path_type != napi_string || depth_type != napi_number) return throw_type_error_if_clear(env, "sandbox parent guard received malformed arguments");

  double numeric_depth = 0;
  uint32_t depth = 0;
  status = napi_get_value_double(env, argv[1], &numeric_depth);
  if (status != napi_ok) return throw_error_if_clear(env, "sandbox parent guard depth conversion failed");
  status = napi_get_value_uint32(env, argv[1], &depth);
  if (status != napi_ok) return throw_error_if_clear(env, "sandbox parent guard depth conversion failed");
  if (numeric_depth != (double)depth || depth == 0 || depth > MAX_ANCESTORS) return throw_range_error_if_clear(env, "sandbox parent guard depth is outside its bound");

  double source_dev = 0;
  double source_ino = 0;
  if (operation == GUARD_POST_COPY) {
    napi_valuetype dev_type, ino_type;
    status = napi_typeof(env, argv[2], &dev_type);
    if (status != napi_ok) return throw_error_if_clear(env, "sandbox parent guard device inspection failed");
    status = napi_typeof(env, argv[3], &ino_type);
    if (status != napi_ok) return throw_error_if_clear(env, "sandbox parent guard inode inspection failed");
    if (dev_type != napi_number || ino_type != napi_number) return throw_type_error_if_clear(env, "sandbox parent guard received malformed root identity");
    status = napi_get_value_double(env, argv[2], &source_dev);
    if (status != napi_ok) return throw_error_if_clear(env, "sandbox parent guard device conversion failed");
    status = napi_get_value_double(env, argv[3], &source_ino);
    if (status != napi_ok) return throw_error_if_clear(env, "sandbox parent guard inode conversion failed");
  }

  size_t utf8_length = 0;
  status = napi_get_value_string_utf8(env, argv[0], NULL, 0, &utf8_length);
  if (status != napi_ok || utf8_length == 0 || utf8_length >= MAX_PATH_BYTES) return throw_range_error_if_clear(env, "sandbox parent guard path is outside its bound");
  guard_work *request = (guard_work *)calloc(1, sizeof(*request));
  if (request == NULL) return throw_error_if_clear(env, "sandbox parent guard allocation failed");
  request->path = (char *)malloc(utf8_length + 1);
  if (request->path == NULL) {
    free(request);
    return throw_error_if_clear(env, "sandbox parent guard path allocation failed");
  }
  size_t copied = 0;
  status = napi_get_value_string_utf8(env, argv[0], request->path, utf8_length + 1, &copied);
  if (status != napi_ok || copied != utf8_length) {
    free(request->path);
    free(request);
    return throw_type_error_if_clear(env, "sandbox parent guard path encoding failed");
  }
  request->depth = depth;
  request->operation = operation;
  request->source_dev = source_dev;
  request->source_ino = source_ino;
  if (request->path[0] != '/') {
    free(request->path);
    free(request);
    return throw_type_error_if_clear(env, "sandbox parent guard requires an absolute POSIX path");
  }
  for (size_t i = 0; i < utf8_length; i++) {
    if (request->path[i] == '\0') {
      free(request->path);
      free(request);
      return throw_type_error_if_clear(env, "sandbox parent guard path contains NUL");
    }
  }
  if (request->path[utf8_length - 1] == '/') {
    free(request->path);
    free(request);
    return throw_type_error_if_clear(env, "sandbox parent guard path is not canonical");
  }
  size_t component_start = 1;
  for (size_t i = 1; i <= utf8_length; i++) {
    if (i != utf8_length && request->path[i] != '/') continue;
    size_t component_length = i - component_start;
    if (component_length == 0 || (component_length == 1 && request->path[component_start] == '.') ||
        (component_length == 2 && request->path[component_start] == '.' && request->path[component_start + 1] == '.')) {
      free(request->path);
      free(request);
      return throw_type_error_if_clear(env, "sandbox parent guard path is not canonical");
    }
    component_start = i + 1;
  }

  size_t end = utf8_length;
  if (operation == GUARD_PRE_COPY) {
    request->leaf_offset = utf8_length;
    for (size_t index = depth; index > 0; index--) {
      while (end > 1 && request->path[end - 1] != '/') end--;
      size_t offset = end - 1;
      if (offset <= 1 || offset >= end) {
        free(request->path);
        free(request);
        return throw_type_error_if_clear(env, "sandbox parent guard path depth is inconsistent");
      }
      request->offsets[index - 1] = offset;
      end = offset;
    }
  } else {
    for (size_t index = 0; index < depth; index++) {
      size_t previous_end = end;
      while (end > 1 && request->path[end - 1] != '/') end--;
      size_t offset = end - 1;
      if (offset == 0) offset = 1;
      if (offset >= previous_end) {
        free(request->path);
        free(request);
        return throw_type_error_if_clear(env, "sandbox parent guard path depth is inconsistent");
      }
      end = offset;
    }
    request->root_offset = end;
    if (request->root_offset >= utf8_length) {
      free(request->path);
      free(request);
      return throw_type_error_if_clear(env, "sandbox parent guard path depth is inconsistent");
    }
    request->offsets[depth - 1] = utf8_length;
    end = utf8_length;
    for (size_t index = depth - 1; index > 0; index--) {
      while (end > 1 && request->path[end - 1] != '/') end--;
      size_t offset = end - 1;
      if (offset <= request->root_offset || offset >= end) {
        free(request->path);
        free(request);
        return throw_type_error_if_clear(env, "sandbox parent guard path depth is inconsistent");
      }
      request->offsets[index - 1] = offset;
      end = offset;
    }
  }

  napi_value promise = NULL;
  napi_value resource_name = NULL;
  napi_value async_resource = NULL;
  status = napi_create_promise(env, &request->deferred, &promise);
  if (status != napi_ok) {
    free(request->path);
    free(request);
    return throw_error_if_clear(env, "sandbox parent guard promise creation failed");
  }
  status = napi_create_string_utf8(env, "sandbox-parent-guard", NAPI_AUTO_LENGTH, &resource_name);
  if (status != napi_ok) return reject_prequeue_failure(env, request, promise, "sandbox parent guard resource name creation failed", false);
  status = napi_create_object(env, &async_resource);
  if (status != napi_ok) return reject_prequeue_failure(env, request, promise, "sandbox parent guard async resource creation failed", false);
  status = napi_create_async_work(env, async_resource, resource_name, complete_pass, finish_work, request, &request->work);
  if (status != napi_ok) return reject_prequeue_failure(env, request, promise, "sandbox parent guard async work creation failed", false);
  status = napi_queue_async_work(env, request->work);
  if (status != napi_ok) return reject_prequeue_failure(env, request, promise, "sandbox parent guard async work queue failed", true);
  return promise;
}

static napi_value guard_pre_copy(napi_env env, napi_callback_info info) {
  return start_guard(env, info, GUARD_PRE_COPY);
}

static napi_value guard_post_copy(napi_env env, napi_callback_info info) {
  return start_guard(env, info, GUARD_POST_COPY);
}

#define MAX_PUBLICATION_PATH_BYTES 12289

typedef enum {
  PUBLICATION_PHASE_SUCCESS,
  PUBLICATION_PHASE_CHMOD,
  PUBLICATION_PHASE_RENAME,
  PUBLICATION_PHASE_COMPLETION,
} publication_phase;

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  char *staged_path;
  char *target_path;
  publication_phase phase;
  int status;
  int mode;
} publication_work;

static int publication_path_is_canonical(const char *path, size_t length) {
  if (length == 0 || path[0] != '/' || path[length - 1] == '/') return 0;
  size_t component_start = 1;
  for (size_t index = 1; index <= length; index++) {
    if (path[index - 1] == '\\') return 0;
    if (index != length && path[index] != '/') continue;
    size_t component_length = index - component_start;
    if (component_length == 0 ||
        (component_length == 1 && path[component_start] == '.') ||
        (component_length == 2 && path[component_start] == '.' && path[component_start + 1] == '.')) return 0;
    component_start = index + 1;
  }
  return 1;
}

static int copy_publication_path(napi_env env, napi_value value, char **output) {
  size_t utf16_length = 0;
  napi_status status = napi_get_value_string_utf16(env, value, NULL, 0, &utf16_length);
  if (status != napi_ok) {
    throw_error_if_clear(env, "sandbox workspace publication UTF-16 path inspection failed");
    return 0;
  }
  if (utf16_length == 0 || utf16_length > 4096) {
    throw_range_error_if_clear(env, "sandbox workspace publication path is outside its bound");
    return 0;
  }
  size_t length = 0;
  status = napi_get_value_string_utf8(env, value, NULL, 0, &length);
  if (status != napi_ok) {
    throw_error_if_clear(env, "sandbox workspace publication path inspection failed");
    return 0;
  }
  if (length == 0 || length >= MAX_PUBLICATION_PATH_BYTES) {
    throw_range_error_if_clear(env, "sandbox workspace publication path is outside its bound");
    return 0;
  }
  char *path = (char *)malloc(length + 1);
  if (path == NULL) {
    throw_error_if_clear(env, "sandbox workspace publication path allocation failed");
    return 0;
  }
  size_t copied = 0;
  status = napi_get_value_string_utf8(env, value, path, length + 1, &copied);
  if (status != napi_ok || copied != length) {
    free(path);
    throw_type_error_if_clear(env, "sandbox workspace publication path encoding failed");
    return 0;
  }
  if (memchr(path, '\0', length) != NULL || !publication_path_is_canonical(path, length)) {
    free(path);
    throw_type_error_if_clear(env, "sandbox workspace publication path is not canonical");
    return 0;
  }
  *output = path;
  return 1;
}

static void free_publication_work(publication_work *request) {
  free(request->staged_path);
  free(request->target_path);
  free(request);
}

static napi_value reject_publication_prequeue_failure(
    napi_env env, publication_work *request, napi_value promise, const char *message, bool has_work) {
  napi_value reason = NULL;
  if (!take_pending_exception(env, &reason)) {
    napi_value text = NULL;
    napi_status status = napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &text);
    if (status == napi_ok) status = napi_create_error(env, NULL, text, &reason);
    if (status != napi_ok && !make_failure_reason(env, &reason)) {
      abort_napi_failure("unable to construct sandbox workspace publication rejection");
    }
  }
  if (has_work) delete_async_work_or_fatal(env, request->work);
  reject_deferred_or_fatal(env, request->deferred, reason);
  free_publication_work(request);
  return promise;
}

static void execute_publication(napi_env env, void *data) {
  (void)env;
  publication_work *request = (publication_work *)data;
  request->phase = PUBLICATION_PHASE_COMPLETION;
  request->status = UV_ECANCELED;

  uv_fs_t fs_request;
  memset(&fs_request, 0, sizeof(fs_request));
  int result = uv_fs_chmod(uv_default_loop(), &fs_request, request->staged_path, request->mode, NULL);
  uv_fs_req_cleanup(&fs_request);
  if (result < 0) {
    request->phase = PUBLICATION_PHASE_CHMOD;
    request->status = result;
    return;
  }

  memset(&fs_request, 0, sizeof(fs_request));
  result = uv_fs_rename(uv_default_loop(), &fs_request, request->staged_path, request->target_path, NULL);
  uv_fs_req_cleanup(&fs_request);
  if (result < 0) {
    request->phase = PUBLICATION_PHASE_RENAME;
    request->status = result;
    return;
  }

  request->phase = PUBLICATION_PHASE_SUCCESS;
  request->status = 0;
}

static napi_status make_publication_result(napi_env env, publication_work *request, napi_value *output) {
  napi_value result = NULL;
  napi_value value = NULL;
  napi_status status = napi_create_object(env, &result);
  if (status != napi_ok) return status;
  const char *phase = request->phase == PUBLICATION_PHASE_CHMOD ? "chmod" :
      request->phase == PUBLICATION_PHASE_RENAME ? "rename" :
      request->phase == PUBLICATION_PHASE_COMPLETION ? "completion" : "success";
  status = napi_create_string_utf8(env, phase, NAPI_AUTO_LENGTH, &value);
  if (status != napi_ok || (status = set_named(env, result, "phase", value)) != napi_ok) return status;
  status = napi_create_int32(env, request->status, &value);
  if (status != napi_ok || (status = set_named(env, result, "status", value)) != napi_ok) return status;
  if (request->status < 0) {
    status = napi_create_string_utf8(env, uv_err_name(request->status), NAPI_AUTO_LENGTH, &value);
    if (status != napi_ok || (status = set_named(env, result, "code", value)) != napi_ok) return status;
    status = napi_create_string_utf8(env, uv_strerror(request->status), NAPI_AUTO_LENGTH, &value);
    if (status != napi_ok || (status = set_named(env, result, "message", value)) != napi_ok) return status;
  }
  *output = result;
  return napi_ok;
}

static void finish_publication(napi_env env, napi_status completion_status, void *data) {
  publication_work *request = (publication_work *)data;
  if (completion_status != napi_ok) {
    request->phase = PUBLICATION_PHASE_COMPLETION;
    request->status = UV_ECANCELED;
  }

  napi_value result = NULL;
  napi_status status = make_publication_result(env, request, &result);
  if (status == napi_ok) status = napi_resolve_deferred(env, request->deferred, result);
  if (status != napi_ok) {
    napi_value reason = NULL;
    if (!make_failure_reason(env, &reason)) abort_napi_failure("unable to construct sandbox workspace publication rejection");
    reject_deferred_or_fatal(env, request->deferred, reason);
  }

  delete_async_work_or_fatal(env, request->work);
  free_publication_work(request);
}
 
static napi_value publish_staged_copy(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_status status = napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (status != napi_ok || argc != 3) return throw_type_error_if_clear(env, "sandbox workspace publication received malformed arguments");

  napi_valuetype staged_type, target_type, mode_type;
  status = napi_typeof(env, argv[0], &staged_type);
  if (status != napi_ok) return throw_error_if_clear(env, "sandbox workspace publication staged path inspection failed");
  status = napi_typeof(env, argv[1], &target_type);
  if (status != napi_ok) return throw_error_if_clear(env, "sandbox workspace publication target path inspection failed");
  status = napi_typeof(env, argv[2], &mode_type);
  if (status != napi_ok) return throw_error_if_clear(env, "sandbox workspace publication mode inspection failed");
  if (staged_type != napi_string || target_type != napi_string || mode_type != napi_number) {
    return throw_type_error_if_clear(env, "sandbox workspace publication received malformed arguments");
  }

  double numeric_mode = 0;
  status = napi_get_value_double(env, argv[2], &numeric_mode);
  if (status != napi_ok) return throw_error_if_clear(env, "sandbox workspace publication mode conversion failed");
  if (!(numeric_mode >= 0 && numeric_mode <= 65535) || (double)(uint32_t)numeric_mode != numeric_mode) {
    return throw_range_error_if_clear(env, "sandbox workspace publication mode is outside its bound");
  }

  publication_work *request = (publication_work *)calloc(1, sizeof(*request));
  if (request == NULL) return throw_error_if_clear(env, "sandbox workspace publication allocation failed");
  if (!copy_publication_path(env, argv[0], &request->staged_path)) {
    free_publication_work(request);
    return NULL;
  }
  if (!copy_publication_path(env, argv[1], &request->target_path)) {
    free_publication_work(request);
    return NULL;
  }
  request->mode = (int)numeric_mode;
  request->phase = PUBLICATION_PHASE_COMPLETION;
  request->status = UV_ECANCELED;

  napi_value promise = NULL;
  napi_value resource_name = NULL;
  napi_value async_resource = NULL;
  status = napi_create_promise(env, &request->deferred, &promise);
  if (status != napi_ok) {
    free_publication_work(request);
    return throw_error_if_clear(env, "sandbox workspace publication promise creation failed");
  }
  status = napi_create_string_utf8(env, "sandbox-workspace-publication", NAPI_AUTO_LENGTH, &resource_name);
  if (status != napi_ok) return reject_publication_prequeue_failure(env, request, promise, "sandbox workspace publication resource name creation failed", false);
  status = napi_create_object(env, &async_resource);
  if (status != napi_ok) return reject_publication_prequeue_failure(env, request, promise, "sandbox workspace publication async resource creation failed", false);
  status = napi_create_async_work(env, async_resource, resource_name, execute_publication, finish_publication, request, &request->work);
  if (status != napi_ok) return reject_publication_prequeue_failure(env, request, promise, "sandbox workspace publication async work creation failed", false);
  status = napi_queue_async_work(env, request->work);
  if (status != napi_ok) return reject_publication_prequeue_failure(env, request, promise, "sandbox workspace publication async work queue failed", true);
  return promise;
}
static napi_value initialize(napi_env env, napi_value exports) {
  napi_value function = NULL;
  napi_status status = napi_create_function(env, "guardPreCopy", NAPI_AUTO_LENGTH, guard_pre_copy, NULL, &function);
  if (status != napi_ok) return throw_error_if_clear(env, "sandbox parent guard initialization failed");
  status = napi_set_named_property(env, exports, "guardPreCopy", function);
  if (status != napi_ok) return throw_error_if_clear(env, "sandbox parent guard export failed");
  status = napi_create_function(env, "guardPostCopy", NAPI_AUTO_LENGTH, guard_post_copy, NULL, &function);
  if (status != napi_ok) return throw_error_if_clear(env, "sandbox parent guard initialization failed");
  status = napi_set_named_property(env, exports, "guardPostCopy", function);
  if (status != napi_ok) return throw_error_if_clear(env, "sandbox parent guard export failed");
  status = napi_create_function(env, "publishStagedCopy", NAPI_AUTO_LENGTH, publish_staged_copy, NULL, &function);
  if (status != napi_ok) return throw_error_if_clear(env, "sandbox parent guard initialization failed");
  status = napi_set_named_property(env, exports, "publishStagedCopy", function);
  if (status != napi_ok) return throw_error_if_clear(env, "sandbox parent guard export failed");
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
