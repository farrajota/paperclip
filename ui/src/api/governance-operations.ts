import type { GovernanceOperationExceptionAdmission, GovernanceOperationExceptionPause, GovernanceOperationExceptionResume, GovernanceOperationExceptionResolve, GovernanceOperationsReadModel } from "@paperclipai/shared/governance-operations";
import { api, detachInflightGet } from "./client";

export const governanceOperationsApi = {
  get: (companyId: string, signal?: AbortSignal) => {
    const path = `/companies/${companyId}/governance-operations`;
    // Match account-scoped company reads: HTTP coalescing is path-only and
    // must not reuse a request admitted under a previous account.
    detachInflightGet(path);
    return api.get<GovernanceOperationsReadModel>(path, { signal });
  },
  admit: (companyId: string, occurrenceId: string, input: GovernanceOperationExceptionAdmission) => api.post(`/companies/${companyId}/governance-operations/occurrences/${occurrenceId}/exceptions`, input),
  pause: (companyId: string, exceptionId: string, input: GovernanceOperationExceptionPause) => api.post(`/companies/${companyId}/governance-operations/exceptions/${exceptionId}/pause`, input),
  resume: (companyId: string, exceptionId: string, input: GovernanceOperationExceptionResume) => api.post(`/companies/${companyId}/governance-operations/exceptions/${exceptionId}/resume`, input),
  resolve: (companyId: string, exceptionId: string, input: GovernanceOperationExceptionResolve) => api.post(`/companies/${companyId}/governance-operations/exceptions/${exceptionId}/resolve`, input),
};
