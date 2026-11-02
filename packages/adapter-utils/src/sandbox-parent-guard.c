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

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  char *path;
  size_t offsets[MAX_ANCESTORS];
  size_t depth;
  int status;
  size_t failed_index;
  int non_directory;
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

static void complete_pass(napi_env env, void *data) {
  guard_work *request = (guard_work *)data;
  for (size_t i = 0; i < request->depth; i++) {
    uv_fs_t fs_request;
    memset(&fs_request, 0, sizeof(fs_request));
    size_t prefix_length = request->offsets[i];
    char saved = request->path[prefix_length];
    request->path[prefix_length] = '\0';
    int result = uv_fs_lstat(uv_default_loop(), &fs_request, request->path, NULL);
    request->path[prefix_length] = saved;
    if (result < 0) {
      request->status = result;
      request->failed_index = i;
      uv_fs_req_cleanup(&fs_request);
      return;
    }
    int is_directory = S_ISDIR(fs_request.statbuf.st_mode);
    uv_fs_req_cleanup(&fs_request);
    if (!is_directory) {
      request->non_directory = 1;
      request->failed_index = i;
      return;
    }
  }
}

static napi_status make_result(napi_env env, guard_work *request, napi_value *output) {
  napi_value result = NULL;
  napi_value value = NULL;
  napi_status status = napi_create_object(env, &result);
  if (status != napi_ok) return status;
  status = napi_create_int32(env, request->status, &value);
  if (status != napi_ok) return status;
  status = napi_set_named_property(env, result, "status", value);
  if (status != napi_ok) return status;
  status = napi_create_uint32(env, (uint32_t)request->failed_index, &value);
  if (status != napi_ok) return status;
  status = napi_set_named_property(env, result, "index", value);
  if (status != napi_ok) return status;
  status = napi_get_boolean(env, request->non_directory, &value);
  if (status != napi_ok) return status;
  status = napi_set_named_property(env, result, "nonDirectory", value);
  if (status != napi_ok) return status;
  if (request->status < 0) {
    size_t length = request->offsets[request->failed_index];
    status = napi_create_string_utf8(env, request->path, length, &value);
    if (status != napi_ok) return status;
    status = napi_set_named_property(env, result, "path", value);
    if (status != napi_ok) return status;
    status = napi_create_string_utf8(env, uv_err_name(request->status), NAPI_AUTO_LENGTH, &value);
    if (status != napi_ok) return status;
    status = napi_set_named_property(env, result, "code", value);
    if (status != napi_ok) return status;
    status = napi_create_string_utf8(env, uv_strerror(request->status), NAPI_AUTO_LENGTH, &value);
    if (status != napi_ok) return status;
    status = napi_set_named_property(env, result, "message", value);
    if (status != napi_ok) return status;
  }
  *output = result;
  return napi_ok;
}

static void finish_work(napi_env env, napi_status completion_status, void *data) {
  guard_work *request = (guard_work *)data;
  if (completion_status != napi_ok && request->status == 0 && !request->non_directory) request->status = UV_ECANCELED;

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

static napi_value guard_ancestors(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_status status = napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (status != napi_ok || argc != 2) return throw_type_error_if_clear(env, "sandbox parent guard expects a path and depth");

  napi_valuetype path_type, depth_type;
  status = napi_typeof(env, argv[0], &path_type);
  if (status != napi_ok) return throw_error_if_clear(env, "sandbox parent guard path inspection failed");
  status = napi_typeof(env, argv[1], &depth_type);
  if (status != napi_ok) return throw_error_if_clear(env, "sandbox parent guard depth inspection failed");
  if (path_type != napi_string || depth_type != napi_number) return throw_type_error_if_clear(env, "sandbox parent guard received malformed arguments");

  uint32_t depth = 0;
  double numeric_depth = 0;
  status = napi_get_value_double(env, argv[1], &numeric_depth);
  if (status != napi_ok) return throw_error_if_clear(env, "sandbox parent guard depth conversion failed");
  status = napi_get_value_uint32(env, argv[1], &depth);
  if (status != napi_ok) return throw_error_if_clear(env, "sandbox parent guard depth conversion failed");
  if (numeric_depth != (double)depth || depth == 0 || depth > MAX_ANCESTORS) return throw_range_error_if_clear(env, "sandbox parent guard depth is outside its bound");

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
  if (request->path[0] != '/') {
    free(request->path);
    free(request);
    return throw_type_error_if_clear(env, "sandbox parent guard requires an absolute POSIX path");
  }
  size_t end = utf8_length;
  request->offsets[depth - 1] = end;
  for (size_t index = depth - 1; index > 0; index--) {
    while (end > 1 && request->path[end - 1] != '/') end--;
    if (end <= 1) {
      free(request->path);
      free(request);
      return throw_type_error_if_clear(env, "sandbox parent guard path depth is inconsistent");
    }
    end--;
    request->offsets[index - 1] = end;
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
  if (status != napi_ok) {
    return reject_prequeue_failure(env, request, promise, "sandbox parent guard resource name creation failed", false);
  }
  status = napi_create_object(env, &async_resource);
  if (status != napi_ok) {
    return reject_prequeue_failure(env, request, promise, "sandbox parent guard async resource creation failed", false);
  }
  status = napi_create_async_work(env, async_resource, resource_name, complete_pass, finish_work, request, &request->work);
  if (status != napi_ok) {
    return reject_prequeue_failure(env, request, promise, "sandbox parent guard async work creation failed", false);
  }
  status = napi_queue_async_work(env, request->work);
  if (status != napi_ok) {
    return reject_prequeue_failure(env, request, promise, "sandbox parent guard async work queue failed", true);
  }
  return promise;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value function = NULL;
  napi_status status = napi_create_function(env, "guardAncestors", NAPI_AUTO_LENGTH, guard_ancestors, NULL, &function);
  if (status != napi_ok) return throw_error_if_clear(env, "sandbox parent guard initialization failed");
  status = napi_set_named_property(env, exports, "guardAncestors", function);
  if (status != napi_ok) return throw_error_if_clear(env, "sandbox parent guard export failed");
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
