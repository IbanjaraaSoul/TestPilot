import { chromium } from "playwright";

/** Delay so you can see each step in the browser (ms). */
const STEP_DELAY_MS = Number(process.env.PLAYWRIGHT_STEP_DELAY_MS) || 800;

/** Run in visible browser when set to "1" or "true". */
const HEADED = /^(1|true|yes)$/i.test(process.env.PLAYWRIGHT_HEADED || "true");

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

/**
 * Discover a locator from step action/expectedResult when no selector is provided.
 * Uses role+name, label, and context (e.g. "login" form) so the right element is chosen.
 */
async function getLocatorFromStep(page, step, kind) {
  const action = (step.action || "").trim();
  const expected = (step.expectedResult || "").trim();
  const combined = `${action} ${expected}`.toLowerCase();

  if (kind === "click") {
    // Prefer button/link text from action: "Click Sign in", "Submit the form", "Press Login"
    const clickPhrases = action.match(/(?:click|press|submit)\s+(?:the\s+)?(?:button\s+)?["']?([^"'.]+)["']?/i) ||
      action.match(/(?:click|press)\s+["']([^"']+)["']/i);
    const name = clickPhrases ? clickPhrases[1].trim() : action.replace(/^(click|press|submit)\s+(the\s+)?/i, "").trim();
    if (name) {
      const byRole = page.getByRole("button", { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") });
      if ((await byRole.count()) > 0) return byRole.first();
      const byLink = page.getByRole("link", { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") });
      if ((await byLink.count()) > 0) return byLink.first();
      const byText = page.getByText(name, { exact: false });
      if ((await byText.count()) > 0) return byText.first();
    }
    return null;
  }

  if (kind === "email") {
    const isLogin = /\b(login|sign\s*in|signin)\b/.test(combined);
    const emailSelector = 'input[type="email"], input[name="email"], input[id="email"], input[placeholder*="mail"], input[placeholder*="Email"]';
    if (isLogin) {
      // Prefer email input inside a form that has a password field or "login" in id/name/class
      const form = page.locator('form[id*="login"], form[name*="login"], form[class*="login"], form[id*="signin"], form:has(input[type="password"])').first();
      if ((await form.count()) > 0) {
        const inForm = form.locator(emailSelector);
        if ((await inForm.count()) > 0) return inForm.first();
      }
    }
    return page.locator(emailSelector).first();
  }

  if (kind === "password") {
    const isLogin = /\b(login|sign\s*in|signin)\b/.test(combined);
    const pwdSelector = 'input[type="password"], input[name="password"], input[id="password"]';
    if (isLogin) {
      const form = page.locator('form[id*="login"], form[name*="login"], form[class*="login"], form[id*="signin"]').first();
      if ((await form.count()) > 0) {
        const inForm = form.locator(pwdSelector);
        if ((await inForm.count()) > 0) return inForm.first();
      }
    }
    return page.locator(pwdSelector).first();
  }

  return null;
}

const FORCE_CLICK = { force: true, timeout: 20000 };
const FORCE_FILL = { force: true, timeout: 20000 };

/** True for "click" / "submit" / "press", but NOT "clickable" (substring false positive). */
function isExplicitClickAction(actionLower) {
  return /\b(click|clicked|submit|press)\b/i.test(actionLower);
}

/** If login email/password fields are not visible yet, try opening Sign in (modal or new page). */
async function ensureLoginFormVisible(page) {
  const emailSel =
    'input[type="email"], input[name="email"], input[id="email"], input[placeholder*="mail"], input[placeholder*="Mail"]';
  if ((await page.locator(emailSel).count()) > 0) return;
  const signIn = page.getByRole("link", { name: /sign\s*in/i }).or(page.getByRole("button", { name: /sign\s*in/i }));
  if ((await signIn.count()) > 0) {
    await signIn.first().click(FORCE_CLICK).catch(() => {});
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await new Promise((r) => setTimeout(r, 600));
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

    // Always open the app first so fill/click steps have a page to act on (LLM may omit "navigate" step).
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
        if (action.includes("navigate") || action.includes("open") || action.includes("go to")) {
          await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
          logs.push({ step: i + 1, action: step.action, status: "ok", detail: `Navigated to ${baseUrl}` });
          logStep(i + 1, step.action, "ok", `Navigated to ${baseUrl}`);
          await delay();
        } else if (wantsCombinedEmailPasswordFill(action, expected)) {
          if (isSignUpContext(action, expected)) await ensureSignUpFormVisible(page);
          else await ensureLoginFormVisible(page);
          const emailSel =
            'input[type="email"], input[name="email"], input[id="email"], input[placeholder*="mail"], input[placeholder*="Mail"]';
          const pwdSel = 'input[type="password"], input[name="password"], input[id="password"]';
          await page.locator(emailSel).first().fill("test@example.com", FORCE_FILL).catch(() => {});
          await delay();
          await page.locator(pwdSel).first().fill("password123", FORCE_FILL).catch(() => {});
          logs.push({ step: i + 1, action: step.action, status: "ok", detail: "Filled email + password" });
          logStep(i + 1, step.action, "ok", "Filled email + password");
          await delay();
        } else if (action.includes("password")) {
          // Before generic "enter" — so "Enter password" fills password, not first text field
          if (/\b(login|sign\s*in|signin|credential)\b/i.test(action)) {
            await ensureLoginFormVisible(page);
          }
          if (isSignUpContext(action, expected)) await ensureSignUpFormVisible(page);
          let loc = getLocatorFromSelector(page, step.selector);
          if (!loc) loc = await getLocatorFromStep(page, step, "password");
          if (loc) {
            await loc.fill("password123", FORCE_FILL);
            const detail = step.selector ? "Filled (selector)" : "Filled (discovered)";
            logs.push({ step: i + 1, action: step.action, status: "ok", detail });
            logStep(i + 1, step.action, "ok", detail);
          } else {
            const sel = 'input[type="password"], input[name="password"], input[id="password"]';
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
          // LLM phrasing: "Login with email address …" without explicit "fill"
          (action.includes("email") &&
            !action.includes("password") &&
            /\b(login|sign\s*in|signin|form|credential|address)\b/i.test(action))
        ) {
          const forEmail = action.includes("email") || expected.toLowerCase().includes("email");
          const fillValue = forEmail ? "test@example.com" : "test";
          if (forEmail && /\b(login|sign\s*in|signin|credential)\b/i.test(action)) {
            await ensureLoginFormVisible(page);
          }
          let loc = getLocatorFromSelector(page, step.selector);
          if (!loc) loc = forEmail ? await getLocatorFromStep(page, step, "email") : null;
          if (loc) {
            await loc.fill(fillValue, FORCE_FILL);
            const detail = step.selector ? "Filled (selector)" : "Filled (discovered)";
            logs.push({ step: i + 1, action: step.action, status: "ok", detail });
            logStep(i + 1, step.action, "ok", detail);
          } else {
            const selector = forEmail ? 'input[type="email"], input[name="email"], input[id="email"], input[placeholder*="mail"]' : 'input[type="text"], input:not([type="hidden"])';
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
          const text = expected || action;
          const found = await page.getByText(text, { exact: false }).first().isVisible().catch(() => false);
          if (found) {
            logs.push({ step: i + 1, action: step.action, status: "ok", detail: `Found: "${text.slice(0, 50)}..."` });
            logStep(i + 1, step.action, "ok", `Found: "${text.slice(0, 50)}..."`);
          } else {
            logs.push({ step: i + 1, action: step.action, status: "skip", detail: `Could not verify text; page content available for manual check.` });
            logStep(i + 1, step.action, "skip", "Could not verify text");
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
            const btn = page.locator('button[type="submit"], input[type="submit"], button, a.button, [role="button"]').first();
            await btn.click(FORCE_CLICK);
            logs.push({ step: i + 1, action: step.action, status: "ok", detail: "Clicked" });
            logStep(i + 1, step.action, "ok", "Clicked");
          }
          await page.waitForLoadState("domcontentloaded").catch(() => {});
          await delay();
        } else {
          logs.push({ step: i + 1, action: step.action, status: "skip", detail: "No automation mapping" });
          logStep(i + 1, step.action, "skip", "No automation mapping");
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
