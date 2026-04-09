import { chromium } from "playwright";

/** Delay so you can see each step in the browser (ms). */
const STEP_DELAY_MS = Number(process.env.PLAYWRIGHT_STEP_DELAY_MS) || 800;

/** Run in visible browser when set to "1" or "true". */
const HEADED = /^(1|true|yes)$/i.test(process.env.PLAYWRIGHT_HEADED || "true");

/**
 * Lenient mode: skipped steps / failed text verify do not fail the whole test.
 * Default is strict (robust): skips and verify misses fail the run.
 */
const LENIENT = /^(1|true|yes)$/i.test(process.env.PLAYWRIGHT_LENIENT || "");

/**
 * Runs a single test case against baseUrl using Playwright.
 * By default launches a visible browser so you can watch steps execute.
 */
function logStep(stepNum, action, status, detail) {
  const statusIcon = status === "ok" ? "✓" : status === "fail" ? "✗" : "○";
  console.log(`  [${statusIcon}] Step ${stepNum}: ${action} — ${detail}`);
}

/**
 * Resolve a Playwright locator from step.selector / step.selectorHint for complex flows.
 * Supports: data-testid=, id=/#, name=, role= name=, label=, or plain CSS.
 */
function getLocatorFromSelector(page, selectorStr) {
  const s = (selectorStr || "").trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower.startsWith("data-testid=")) {
    const value = s.slice("data-testid=".length).trim().replace(/^["']|["']$/g, "");
    return value ? page.getByTestId(value) : null;
  }
  if (lower.startsWith("id=") || s.startsWith("#")) {
    const value = s.startsWith("#") ? s.slice(1).trim() : s.slice(3).trim().replace(/^["']|["']$/g, "");
    return value ? page.locator(`#${value.replace(/[^a-zA-Z0-9_-]/g, "\\$&")}`) : null;
  }
  if (lower.startsWith("name=")) {
    const value = s.slice(5).trim().replace(/^["']|["']$/g, "");
    return value ? page.locator(`[name="${value.replace(/"/g, '\\"')}"]`) : null;
  }
  if (lower.startsWith("role=")) {
    const rest = s.slice(5).trim();
    const nameMatch = rest.match(/name\s*=\s*["']([^"']*)["']|name\s*=\s*(\S+)/i);
    const name = nameMatch ? (nameMatch[1] ?? nameMatch[2] ?? "").trim() : undefined;
    const role = rest.replace(/\s*name\s*=\s*["']?[^"'\s]*["']?\s*$/i, "").trim().toLowerCase();
    return page.getByRole(role, name ? { name } : {});
  }
  if (lower.startsWith("label=")) {
    const value = s.slice(6).trim().replace(/^["']|["']$/g, "");
    return value ? page.getByLabel(value) : null;
  }
  return page.locator(s);
}

async function hasLoginUi(page) {
  const pwd = await page.locator('input[type="password"]:visible').count();
  if (pwd > 0) return true;
  const formWithPwd = page.locator("form:has(input[type=\"password\"])").first();
  return (await formWithPwd.count()) > 0;
}

/**
 * Discover a locator from step action/expectedResult when no selector is provided.
 * Uses role+name, label, and context (e.g. "login" form) so the right element is chosen.
 */
async function getLocatorFromStep(page, step, kind) {
  const action = (step.action || "").trim();
  const expected = (step.expectedResult || "").trim();
  const combined = `${action} ${expected}`.toLowerCase();

  if (kind === "click") {
    const clickPhrases =
      action.match(/(?:click|press|submit)\s+(?:the\s+)?(?:button\s+)?["']?([^"'.]+)["']?/i) ||
      action.match(/(?:click|press)\s+["']([^"']+)["']/i);
    const name = clickPhrases
      ? clickPhrases[1].trim()
      : action.replace(/^(click|press|submit)\s+(the\s+)?/i, "").trim();
    if (name) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const byRole = page.getByRole("button", { name: new RegExp(escaped, "i") });
      if ((await byRole.count()) > 0) return byRole.first();
      const byLink = page.getByRole("link", { name: new RegExp(escaped, "i") });
      if ((await byLink.count()) > 0) return byLink.first();
      const byText = page.getByText(name, { exact: false });
      if ((await byText.count()) > 0) return byText.first();
    }
    return null;
  }

  if (kind === "email") {
    const isLogin = /\b(login|sign\s*in|signin|credential)\b/.test(combined);
    const emailSelector =
      'input[type="email"], input[name="email"], input[id="email"], input[placeholder*="mail"], input[placeholder*="Mail"]';
    if (isLogin) {
      const form = page
        .locator(
          'form[id*="login"], form[name*="login"], form[class*="login"], form[id*="signin"], form:has(input[type="password"])'
        )
        .first();
      if ((await form.count()) > 0) {
        const inForm = form.locator(emailSelector);
        if ((await inForm.count()) > 0) return inForm.first();
      }
      // Do not fall back to first email on page for login flows — wrong (e.g. newsletter).
      return null;
    }
    return page.locator(emailSelector).first();
  }

  if (kind === "password") {
    const isLogin = /\b(login|sign\s*in|signin|credential)\b/.test(combined);
    const pwdSelector = 'input[type="password"], input[name="password"], input[id="password"]';
    if (isLogin) {
      const form = page
        .locator('form[id*="login"], form[name*="login"], form[class*="login"], form[id*="signin"]')
        .first();
      if ((await form.count()) > 0) {
        const inForm = form.locator(pwdSelector);
        if ((await inForm.count()) > 0) return inForm.first();
      }
      return page.locator('input[type="password"]:visible').first();
    }
    return page.locator(pwdSelector).first();
  }

  return null;
}

const FORCE_CLICK = { force: true, timeout: 20000 };
const FORCE_FILL = { force: true, timeout: 20000 };

/** True for "click" / "submit" / "press", but NOT "clickable". */
function isExplicitClickAction(actionLower) {
  return /\b(click|clicked|submit|press)\b/i.test(actionLower);
}

/** Navigate intent without also clicking in the same step. */
function isNavigateOnlyAction(action) {
  const a = action.toLowerCase();
  const hasNav =
    /\b(navigate|go\s+to|open|visit)\b/.test(a) || a.trimStart().startsWith("go to");
  const hasClick = /\b(click|press|submit)\b/i.test(a);
  return hasNav && !hasClick;
}

/** Same step asks to open URL and click something (e.g. "go to x.com and click Login"). */
function isNavigateAndClickAction(action) {
  const a = action.toLowerCase();
  const hasNav =
    /\b(navigate|go\s+to|open|visit)\b/.test(a) || a.trimStart().startsWith("go to");
  const hasClick = /\b(click|press)\b/i.test(a) || /\bsubmit\b/i.test(a);
  return hasNav && hasClick;
}

/** Extract quoted or unquoted target after "click" for navigate+click steps. */
function extractClickTargetFromAction(stepAction) {
  const s = stepAction || "";
  const q = s.match(/click\s+(?:on\s+)?(?:the\s+)?["']([^"']+)["']/i);
  if (q) return q[1].trim();
  const q2 = s.match(/click\s+(?:on\s+)?(?:the\s+)?([A-Za-z][A-Za-z0-9\s]{0,40}?)(?:\s+button|\s+link|$)/i);
  if (q2) return q2[1].trim();
  return "";
}

async function clickByAccessibleName(page, targetLabel) {
  if (!targetLabel || !targetLabel.trim()) return false;
  const escaped = targetLabel.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escaped, "i");
  for (const role of ["link", "button"]) {
    const loc = page.getByRole(role, { name: re });
    const n = await loc.count();
    if (n > 0) {
      await loc.first().click(FORCE_CLICK);
      return true;
    }
  }
  return false;
}

/** Try to reveal login UI: Sign in, Login, Office login, etc. */
async function ensureLoginFormVisible(page) {
  if (await hasLoginUi(page)) return;
  const patterns = [/sign\s*in/i, /log\s*in/i, /login/i];
  for (const pat of patterns) {
    const link = page.getByRole("link", { name: pat });
    const btn = page.getByRole("button", { name: pat });
    if ((await link.count()) > 0) {
      await link.first().click(FORCE_CLICK).catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await new Promise((r) => setTimeout(r, 900));
      if (await hasLoginUi(page)) return;
    }
    if ((await btn.count()) > 0) {
      await btn.first().click(FORCE_CLICK).catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await new Promise((r) => setTimeout(r, 900));
      if (await hasLoginUi(page)) return;
    }
  }
}

/** Open Join / sign-up UI if inputs are not visible (marketing sites use modals). */
async function ensureSignUpFormVisible(page) {
  if ((await page.locator("input:visible").count()) >= 2) return;
  const join = page.getByRole("button", { name: /join\s*one\s*pay/i });
  if ((await join.count()) > 0) {
    await join.first().click(FORCE_CLICK).catch(() => {});
    await new Promise((r) => setTimeout(r, 900));
  }
}

function wantsCombinedEmailPasswordFill(action, expected) {
  const blob = `${action} ${expected || ""}`.toLowerCase();
  return /\bemail\b/.test(blob) && /\bpassword\b/.test(blob) && /\b(fill|enter|type|input|form|fields)\b/.test(blob);
}

function isSignUpContext(action, expected) {
  return /\b(sign\s*up|sign-up|join\s*one|onboard|register|one\s*time\s*sign)\b/i.test(`${action} ${expected || ""}`);
}

function isLoginFlowStep(action, expected) {
  const blob = `${action} ${expected || ""}`.toLowerCase();
  return /\b(login|sign\s*in|signin|credential|password)\b/.test(blob);
}

/** Playwright requires a full URL with a scheme (https:// or http://). */
function normalizeBaseUrl(raw) {
  const t = (raw || "").trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t;
  const lower = t.toLowerCase();
  if (lower.startsWith("localhost") || lower.startsWith("127.0.0.1")) {
    return `http://${t}`;
  }
  return `https://${t}`;
}

function failStep(msg) {
  throw new Error(msg);
}

export async function runTest(testCase, rawBaseUrl, options = {}) {
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const baseUrl = normalizeBaseUrl(rawBaseUrl);
  if (!baseUrl) {
    throw new Error("Base URL is required (e.g. https://onepay.com or http://localhost:3456).");
  }
  const steps = testCase.steps || [];
  const logs = [];
  let passed = true;
  let errorMessage = null;

  onProgress({
    type: "test_meta",
    title: testCase.title,
    testCaseId: testCase.id,
    stepTotal: steps.length,
    baseUrl,
  });

  console.log("\n--- Test run ---");
  console.log(`Test: ${testCase.title}`);
  console.log(`URL:  ${baseUrl}${rawBaseUrl !== baseUrl ? ` (normalized from "${rawBaseUrl}")` : ""}`);
  console.log("Steps:");

  let browser;
  try {
    browser = await chromium.launch({
      headless: !HEADED,
      slowMo: HEADED ? 150 : 0,
      timeout: 30000,
    });
  } catch (launchErr) {
    const msg = launchErr.message || "";
    const hint =
      HEADED && (msg.includes("Executable doesn't exist") || msg.includes("browserType.launch"))
        ? " Run the server from a normal terminal on this machine (e.g. Terminal.app) so the test browser can open. Or set PLAYWRIGHT_HEADED=false in .env to run without a visible window."
        : "";
    throw new Error(`Browser could not launch: ${msg}${hint}`);
  }
  try {
    const page = await browser.newPage();
    const delay = () => new Promise((r) => setTimeout(r, STEP_DELAY_MS));

    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await delay();
    console.log("  [✓] (initial) Navigate to app — OK");
    onProgress({ type: "nav_done", baseUrl });

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const action = (step.action || "").toLowerCase();
      const expected = step.expectedResult || "";

      onProgress({
        type: "step_start",
        stepIndex: i + 1,
        stepTotal: steps.length,
        action: step.action || "",
      });

      try {
        // Navigate + click in one step (e.g. "go to site and click Login")
        if (isNavigateAndClickAction(action)) {
          await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
          await delay();
          const target = extractClickTargetFromAction(step.action || "");
          if (!target) {
            failStep(
              'Navigate+click step needs a clear target (e.g. click "Login" or click Login). Could not parse target from action.'
            );
          }
          const clicked = await clickByAccessibleName(page, target);
          if (!clicked) {
            failStep(
              `Could not find a visible link or button matching "${target}". The page may use different wording (e.g. "Office Login"); add an explicit selector to the step.`
            );
          }
          logs.push({
            step: i + 1,
            action: step.action,
            status: "ok",
            detail: `Navigated to ${baseUrl} and clicked "${target}"`,
          });
          logStep(i + 1, step.action, "ok", `Navigated + clicked "${target}"`);
          await delay();
        } else if (isNavigateOnlyAction(action)) {
          await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
          logs.push({ step: i + 1, action: step.action, status: "ok", detail: `Navigated to ${baseUrl}` });
          logStep(i + 1, step.action, "ok", `Navigated to ${baseUrl}`);
          await delay();
        } else if (wantsCombinedEmailPasswordFill(action, expected)) {
          if (isSignUpContext(action, expected)) await ensureSignUpFormVisible(page);
          else await ensureLoginFormVisible(page);
          if (!LENIENT && isLoginFlowStep(action, expected) && !(await hasLoginUi(page))) {
            failStep(
              "Login form not visible (no password field). Open Login/Sign in first or add a selector for the email field."
            );
          }
          const emailSel =
            'input[type="email"], input[name="email"], input[id="email"], input[placeholder*="mail"], input[placeholder*="Mail"]';
          const pwdSel = 'input[type="password"], input[name="password"], input[id="password"]';
          const loginCombined = isLoginFlowStep(action, expected) && !isSignUpContext(action, expected);

          let emailLoc = getLocatorFromSelector(page, step.selector);
          if (!emailLoc) emailLoc = await getLocatorFromStep(page, step, "email");
          let pwdLoc = await getLocatorFromStep(page, step, "password");
          if (!pwdLoc) pwdLoc = getLocatorFromSelector(page, step.selector);

          if (loginCombined) {
            if (!emailLoc && !LENIENT) {
              failStep(
                "Combined login: no email field inside the login form (newsletter fields are not used). Add step.selector or split into separate steps."
              );
            }
            if (!pwdLoc && !LENIENT) {
              failStep("Combined login: no password field found. Add step.selector or open the login form first.");
            }
            if (!emailLoc) emailLoc = page.locator(emailSel).first();
            if (!pwdLoc) pwdLoc = page.locator(pwdSel).first();
          } else {
            if (!emailLoc) emailLoc = page.locator(emailSel).first();
            if (!pwdLoc) pwdLoc = page.locator(pwdSel).first();
          }

          await emailLoc.fill("test@example.com", FORCE_FILL);
          await delay();
          await pwdLoc.fill("password123", FORCE_FILL);
          logs.push({ step: i + 1, action: step.action, status: "ok", detail: "Filled email + password" });
          logStep(i + 1, step.action, "ok", "Filled email + password");
          await delay();
        } else if (action.includes("password")) {
          if (/\b(login|sign\s*in|signin|credential)\b/i.test(action)) {
            await ensureLoginFormVisible(page);
          }
          if (isSignUpContext(action, expected)) await ensureSignUpFormVisible(page);
          if (!LENIENT && /\b(login|sign\s*in|signin|credential)\b/i.test(action) && !(await hasLoginUi(page))) {
            failStep("Password step: login form not visible. Click Login/Sign in first or add a selector.");
          }
          let loc = getLocatorFromSelector(page, step.selector);
          if (!loc) loc = await getLocatorFromStep(page, step, "password");
          if (loc) {
            await loc.fill("password123", FORCE_FILL);
            const detail = step.selector ? "Filled (selector)" : "Filled (discovered)";
            logs.push({ step: i + 1, action: step.action, status: "ok", detail });
            logStep(i + 1, step.action, "ok", detail);
          } else {
            const sel = 'input[type="password"]:visible';
            const n = await page.locator(sel).count();
            if (n === 0) failStep("No visible password field found. Add step.selector or open the correct form.");
            await page.locator(sel).first().fill("password123", FORCE_FILL);
            logs.push({ step: i + 1, action: step.action, status: "ok", detail: "Filled password" });
            logStep(i + 1, step.action, "ok", "Filled password");
          }
          await delay();
        } else if (
          action.includes("enter") ||
          action.includes("type") ||
          action.includes("fill") ||
          action.includes("input") ||
          (action.includes("email") &&
            !action.includes("password") &&
            /\b(login|sign\s*in|signin|form|credential|address)\b/i.test(action))
        ) {
          const forEmail = action.includes("email") || expected.toLowerCase().includes("email");
          const fillValue = forEmail ? "test@example.com" : "test";
          if (forEmail && /\b(login|sign\s*in|signin|credential)\b/i.test(action)) {
            await ensureLoginFormVisible(page);
            if (!LENIENT && !(await hasLoginUi(page))) {
              failStep(
                "Email step expects a login form but none is visible (need a password field or login form). Use a navigate+click step to open Login, or add a selector."
              );
            }
          }
          let loc = getLocatorFromSelector(page, step.selector);
          if (!loc) loc = forEmail ? await getLocatorFromStep(page, step, "email") : null;
          if (loc) {
            await loc.fill(fillValue, FORCE_FILL);
            const detail = step.selector ? "Filled (selector)" : "Filled (discovered)";
            logs.push({ step: i + 1, action: step.action, status: "ok", detail });
            logStep(i + 1, step.action, "ok", detail);
          } else {
            if (forEmail && /\b(login|sign\s*in|signin|credential)\b/i.test(action)) {
              failStep(
                "Could not find an email field inside a login context. Newsletter or other email fields are not used for login steps."
              );
            }
            const selector = forEmail
              ? 'input[type="email"], input[name="email"], input[id="email"], input[placeholder*="mail"]'
              : 'input[type="text"], input:not([type="hidden"])';
            const count = await page.locator(selector).count();
            if (count === 0) failStep(`No matching input found for: ${selector}`);
            await page.locator(selector).first().fill(fillValue, FORCE_FILL);
            logs.push({ step: i + 1, action: step.action, status: "ok", detail: "Filled input" });
            logStep(i + 1, step.action, "ok", "Filled input");
          }
          await delay();
        } else if (
          action.includes("see") ||
          action.includes("verify") ||
          action.includes("check") ||
          action.includes("assert") ||
          action.includes("ensure") ||
          action.includes("confirm") ||
          action.includes("validate")
        ) {
          await delay();
          const text = (expected || action || "").trim();
          if (!text) {
            failStep("Verify step needs expectedResult or a clear action to search for.");
          }
          const found = await page.getByText(text, { exact: false }).first().isVisible().catch(() => false);
          if (found) {
            logs.push({ step: i + 1, action: step.action, status: "ok", detail: `Found: "${text.slice(0, 50)}..."` });
            logStep(i + 1, step.action, "ok", `Found: "${text.slice(0, 50)}..."`);
          } else if (LENIENT) {
            logs.push({
              step: i + 1,
              action: step.action,
              status: "skip",
              detail: "Could not verify text (lenient mode).",
            });
            logStep(i + 1, step.action, "skip", "Could not verify text");
          } else {
            failStep(`Verify failed: text not found on page — "${text.slice(0, 120)}${text.length > 120 ? "…" : ""}"`);
          }
        } else if (isExplicitClickAction(action)) {
          let loc = getLocatorFromSelector(page, step.selector);
          if (!loc) loc = await getLocatorFromStep(page, step, "click");
          if (loc) {
            await loc.click(FORCE_CLICK);
            const detail = step.selector ? "Clicked (selector)" : "Clicked (discovered)";
            logs.push({ step: i + 1, action: step.action, status: "ok", detail });
            logStep(i + 1, step.action, "ok", detail);
          } else {
            const signIn = page.getByRole("button", { name: /sign\s*in|submit|log\s*in/i });
            const signInLink = page.getByRole("link", { name: /sign\s*in|log\s*in/i });
            if ((await signIn.count()) > 0) {
              await signIn.first().click(FORCE_CLICK);
              logs.push({ step: i + 1, action: step.action, status: "ok", detail: "Clicked (matched Sign in / submit)" });
              logStep(i + 1, step.action, "ok", "Clicked (matched name)");
            } else if ((await signInLink.count()) > 0) {
              await signInLink.first().click(FORCE_CLICK);
              logs.push({ step: i + 1, action: step.action, status: "ok", detail: "Clicked (link)" });
              logStep(i + 1, step.action, "ok", "Clicked (link)");
            } else {
              failStep(
                'Click step: no matching button/link found from the action text. Add step.selector (e.g. role=link name=NextGen Office Login) or rephrase (e.g. "Click NextGen Office Login").'
              );
            }
          }
          await page.waitForLoadState("domcontentloaded").catch(() => {});
          await delay();
        } else {
          const msg =
            "No automation mapping for this step. Rephrase (navigate, fill, click, verify) or add an optional selector.";
          if (LENIENT) {
            logs.push({ step: i + 1, action: step.action, status: "skip", detail: msg });
            logStep(i + 1, step.action, "skip", "No automation mapping");
          } else {
            failStep(msg);
          }
        }
        const doneLog = logs.filter((l) => l.step === i + 1).pop();
        if (doneLog) {
          onProgress({
            type: "step_done",
            stepIndex: i + 1,
            stepTotal: steps.length,
            action: step.action || "",
            status: doneLog.status,
            detail: doneLog.detail || "",
          });
        }
      } catch (stepErr) {
        passed = false;
        errorMessage = stepErr.message;
        logs.push({ step: i + 1, action: step.action, status: "fail", detail: stepErr.message });
        logStep(i + 1, step.action, "fail", stepErr.message);
        onProgress({
          type: "step_done",
          stepIndex: i + 1,
          stepTotal: steps.length,
          action: step.action || "",
          status: "fail",
          detail: stepErr.message,
        });
        break;
      }
    }

    if (passed && logs.length === 0 && steps.length > 0) {
      logs.push({ step: "-", action: "No steps could be automated", status: "skip", detail: "Review steps manually." });
    }

    // Strict: any skipped step fails the test (unless lenient)
    if (passed && !LENIENT && logs.some((l) => l.status === "skip")) {
      passed = false;
      errorMessage = "Strict mode: one or more steps were skipped (set PLAYWRIGHT_LENIENT=true to allow skips).";
    }

    if (HEADED && passed) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  } finally {
    await browser.close();
  }

  console.log(passed ? "Result: PASSED\n" : `Result: FAILED — ${errorMessage || "see steps above"}\n`);

  return {
    testCaseId: testCase.id,
    title: testCase.title,
    passed,
    errorMessage,
    stepLogs: logs,
  };
}
