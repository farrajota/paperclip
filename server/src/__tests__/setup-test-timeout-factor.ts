import { vi } from "vitest";

import { installScaledWaitFor } from "./helpers/test-timeout-factor.js";

installScaledWaitFor(vi);
