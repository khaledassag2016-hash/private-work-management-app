import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

function emit(record, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
  process.exitCode = exitCode;
}

function fail(code, exitCode) {
  emit({ status: "ERROR", code }, exitCode);
}

function getProcessLocalAccessToken(firebaseToolsRoot) {
  const toolsRoot = resolve(firebaseToolsRoot, "..", "..", "..");
  const isWindows = process.platform === "win32";
  const executable = isWindows ? "powershell.exe" : resolve(toolsRoot, "google-cloud-sdk", "bin", "gcloud");
  const gcloud = resolve(toolsRoot, "google-cloud-sdk", "bin", isWindows ? "gcloud.ps1" : "gcloud");
  const args = isWindows
    ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", gcloud, "auth", "print-access-token", "--quiet"]
    : ["auth", "print-access-token", "--quiet"];
  const token = execFileSync(executable, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 90_000,
    windowsHide: true,
  }).trim();
  if (!token || token.length > 8192 || /[\r\n]/.test(token)) {
    throw new Error("invalid process-local access token");
  }
  return token;
}

async function getAvailableCloudProjectPage(accessToken, quotaProjectId, pageToken) {
  const url = new URL("https://firebase.googleapis.com/v1beta1/availableProjects");
  url.searchParams.set("pageSize", "100");
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "x-goog-user-project": quotaProjectId,
    },
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(new Error("Firebase Management REST request failed"), { httpStatus: response.status });
  }
  const body = await response.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw Object.assign(new Error("invalid response"), { s3Invariant: "AVAILABLE_PROJECTS_RESPONSE_INVALID" });
  }
  const projects = body.projectInfo === undefined ? [] : body.projectInfo;
  if (!Array.isArray(projects)) {
    throw Object.assign(new Error("invalid projectInfo"), { s3Invariant: "AVAILABLE_PROJECTS_RESPONSE_INVALID" });
  }
  const nextPageToken = body.nextPageToken;
  if (nextPageToken !== undefined && typeof nextPageToken !== "string") {
    throw Object.assign(new Error("invalid page token"), { s3Invariant: "AVAILABLE_PROJECTS_RESPONSE_INVALID" });
  }
  return { projects, nextPageToken: nextPageToken || undefined };
}

const [firebaseToolsRoot, projectId, expectedDisplayName, quotaProjectId] = process.argv.slice(2);
if (
  !firebaseToolsRoot ||
  !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId ?? "") ||
  !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(quotaProjectId ?? "")
) {
  fail("INVALID_ARGUMENTS", 20);
} else if (!expectedDisplayName || expectedDisplayName.length > 30) {
  fail("INVALID_DISPLAY_NAME", 20);
} else {
  let accessToken;
  try {
    accessToken = getProcessLocalAccessToken(firebaseToolsRoot);
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
      const page = await getAvailableCloudProjectPage(accessToken, quotaProjectId, nextPageToken);
      pagesScanned += 1;
      const items = page.projects;
      projectCount += items.length;
      const matches = items.filter((item) => item?.project === expectedResource);
      if (matches.length > 1 || (match && matches.length > 0)) {
        throw Object.assign(new Error("ambiguous project"), { s3Invariant: "PROJECT_MATCH_AMBIGUOUS" });
      }
      if (matches.length === 1) match = matches[0];
      nextPageToken = page.nextPageToken;
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
  } catch (error) {
    if (error?.s3Invariant) fail(error.s3Invariant, 20);
    else emit({
      status: "ERROR",
      code: "AVAILABLE_PROJECTS_QUERY_FAILED",
      ...(Number.isInteger(error?.httpStatus) ? { httpStatus: error.httpStatus } : {}),
    }, 10);
  } finally {
    accessToken = undefined;
  }
}
