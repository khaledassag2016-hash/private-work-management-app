import { createRequire } from "node:module";
import { resolve } from "node:path";

function emit(record, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
  process.exitCode = exitCode;
}

function fail(code, exitCode) {
  emit({ status: "ERROR", code }, exitCode);
}

function safeHttpStatus(error) {
  const candidates = [
    error?.status,
    error?.statusCode,
    error?.context?.response?.statusCode,
    error?.context?.response?.status,
    error?.response?.status,
  ];
  const value = candidates.find((candidate) => Number.isInteger(Number(candidate)));
  const status = Number(value);
  return status >= 100 && status <= 599 ? status : undefined;
}

const [firebaseToolsRoot, projectId, expectedDisplayName] = process.argv.slice(2);
if (!firebaseToolsRoot || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId ?? "")) {
  fail("INVALID_ARGUMENTS", 20);
} else if (!expectedDisplayName || expectedDisplayName.length > 30) {
  fail("INVALID_DISPLAY_NAME", 20);
} else {
  try {
    const require = createRequire(import.meta.url);
    const projects = require(resolve(firebaseToolsRoot, "lib", "management", "projects.js"));
    if (typeof projects.getAvailableCloudProjectPage !== "function") {
      fail("FIREBASE_TOOLS_API_UNAVAILABLE", 20);
    } else {
      const expectedResource = `projects/${projectId}`;
      const seenTokens = new Set();
      let nextPageToken;
      let pagesScanned = 0;
      let projectCount = 0;
      let match;

      do {
        if (pagesScanned >= 50) {
          throw Object.assign(new Error("pagination bound"), { s3Invariant: "PAGINATION_BOUND_EXCEEDED" });
        }
        const page = await projects.getAvailableCloudProjectPage(1000, nextPageToken);
        pagesScanned += 1;
        const items = Array.isArray(page?.projects) ? page.projects : [];
        projectCount += items.length;
        const matches = items.filter((item) => item?.project === expectedResource);
        if (matches.length > 1 || (match && matches.length > 0)) {
          throw Object.assign(new Error("ambiguous project"), { s3Invariant: "PROJECT_MATCH_AMBIGUOUS" });
        }
        if (matches.length === 1) match = matches[0];
        nextPageToken = typeof page?.nextPageToken === "string" && page.nextPageToken.length > 0
          ? page.nextPageToken
          : undefined;
        if (nextPageToken && !seenTokens.add(nextPageToken)) {
          throw Object.assign(new Error("repeated page token"), { s3Invariant: "PAGINATION_TOKEN_REPEATED" });
        }
      } while (nextPageToken);

      if (match && match.displayName !== expectedDisplayName) {
        fail("DISPLAY_NAME_MISMATCH", 20);
      } else {
        emit({
          status: "PASS",
          available: Boolean(match),
          displayNameMatch: Boolean(match),
          pagesScanned,
          projectCount,
        });
      }
    }
  } catch (error) {
    if (error?.s3Invariant) fail(error.s3Invariant, 20);
    else emit({
      status: "ERROR",
      code: "AVAILABLE_PROJECTS_QUERY_FAILED",
      ...(safeHttpStatus(error) ? { httpStatus: safeHttpStatus(error) } : {}),
    }, 10);
  }
}
