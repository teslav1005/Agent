/**
 * ╔═══════════════════════════════════════════════════════════════════════╗
 * ║     Afnan AI v3.0 - Ultra Advanced Browser Agent                   ║
 * ║     Model: Gemini 3.1 Flash Lite (GA)                              ║
 * ║     Release: March 3, 2026 | GA: May 7, 2026                       ║
 * ║     Features: Deep DOM, Self-Healing, 4 Thinking Levels,         ║
 * ║     Semantic Extraction, Multi-Step Planning, Stealth Mode        ║
 * ╚═══════════════════════════════════════════════════════════════════════╝
 */

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const { chromium } = require('playwright');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const winston = require('winston');
require('dotenv').config();

// ─── Advanced Logger ─────────────────────────────────────────────────
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ level, message, timestamp }) => {
      return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'agent-error.log', level: 'error' }),
    new winston.transports.File({ filename: 'agent-combined.log' })
  ]
});

// ─── App & Server ────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e8,
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Gemini Client ───────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const safetySettings = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

// ─── Global State ────────────────────────────────────────────────────
let browser = null;
let page = null;
let isAgentActive = false;
let browserContext = null;
let currentTaskId = null;

const conversationStore = new Map();
const userActionLog = new Map(); // Store manual user actions

const circuitBreaker = {
  failures: 0,
  lastFailureTime: null,
  state: 'CLOSED',
  threshold: 5,
  timeout: 60000,
};

// ─── Retry & Resilience ──────────────────────────────────────────────
const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
};

function getRetryDelay(attempt) {
  const delay = Math.min(RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt), RETRY_CONFIG.maxDelayMs);
  return delay + Math.random() * 1000;
}

async function withRetry(operation, operationName) {
  let lastError;
  for (let attempt = 0; attempt < RETRY_CONFIG.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      logger.warn(`Retry ${operationName} (${attempt + 1}/${RETRY_CONFIG.maxRetries}): ${error.message}`);
      if (attempt < RETRY_CONFIG.maxRetries - 1) {
        await new Promise(r => setTimeout(r, getRetryDelay(attempt)));
      }
    }
  }
  throw new Error(`[${operationName}] Failed after ${RETRY_CONFIG.maxRetries}: ${lastError.message}`);
}

// ─── Circuit Breaker ─────────────────────────────────────────────────
function checkCircuitBreaker() {
  if (circuitBreaker.state === 'OPEN') {
    if (Date.now() - circuitBreaker.lastFailureTime > circuitBreaker.timeout) {
      circuitBreaker.state = 'HALF_OPEN';
      logger.info('Circuit breaker moved to HALF_OPEN');
    } else {
      throw new Error('Circuit breaker is OPEN - too many failures, cooling down...');
    }
  }
}

function recordSuccess() {
  circuitBreaker.failures = 0;
  circuitBreaker.state = 'CLOSED';
}

function recordFailure() {
  circuitBreaker.failures++;
  circuitBreaker.lastFailureTime = Date.now();
  if (circuitBreaker.failures >= circuitBreaker.threshold) {
    circuitBreaker.state = 'OPEN';
    logger.error('Circuit breaker OPENED - system paused');
  }
}

// ─── Browser Management ──────────────────────────────────────────────
async function initializeBrowser() {
  return withRetry(async () => {
    if (!browser) {
      logger.info('Launching browser...');
      browser = await chromium.launch({
        headless: process.env.BROWSER_HEADLESS !== 'false',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process',
          '--window-size=1920,1080',
          '--disable-blink-features=AutomationControlled',
          '--disable-infobars',
          '--window-position=0,0',
        ],
      });

      browserContext = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        javaScriptEnabled: true,
        bypassCSP: true,
        locale: 'ar-SA',
        timezoneId: 'Asia/Riyadh',
        geolocation: { latitude: 24.7136, longitude: 46.6753 },
        permissions: ['geolocation'],
      });

      page = await browserContext.newPage();
      page.setDefaultTimeout(30000);
      page.setDefaultNavigationTimeout(30000);

      // Stealth scripts
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        window.chrome = { runtime: {} };
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) => (
          parameters.name === 'notifications' 
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(parameters)
        );
      });

      page.on('dialog', async (dialog) => {
        logger.info(`Dialog ${dialog.type()}: ${dialog.message()}`);
        await dialog.accept();
      });

      page.on('console', (msg) => {
        if (msg.type() === 'error') logger.error(`Page Error: ${msg.text()}`);
      });

      page.on('pageerror', (error) => {
        logger.error(`Page Exception: ${error.message}`);
      });

      await page.goto('https://www.google.com', { waitUntil: 'networkidle' });
      logger.info('Browser initialized successfully');
    }
    return { browser, page };
  }, 'initializeBrowser');
}

async function closeBrowser() {
  try {
    if (browserContext) { await browserContext.close(); browserContext = null; }
    if (browser) { await browser.close(); browser = null; page = null; }
    logger.info('Browser closed gracefully');
  } catch (error) {
    logger.error(`Browser Close Error: ${error.message}`);
  }
}

// ─── Deep Semantic DOM Extraction ────────────────────────────────────
async function getDeepPageSnapshot() {
  return withRetry(async () => {
    if (!page) return null;

    const [domData, screenshot] = await Promise.all([
      page.evaluate(() => {
        const maxElements = 200;
        const elements = [];

        const selectors = [
          'button:not([disabled])', 'a[href]', 'input:not([type="hidden"]):not([disabled])',
          'select:not([disabled])', 'textarea:not([disabled])', '[role="button"]',
          '[role="link"]', '[role="textbox"]', '[role="searchbox"]', '[role="combobox"]',
          '[role="listbox"]', '[role="menuitem"]', '[role="tab"]', '[role="checkbox"]',
          '[role="radio"]', '[role="switch"]', '[contenteditable]', '[onclick]',
          'form', 'label', 'h1', 'h2', 'h3', 'nav', 'header', 'main', 'article',
          '[data-testid]', '[data-test]', '[data-cy]', '[data-automation]'
        ];

        const all = document.querySelectorAll(selectors.join(', '));

        all.forEach((el, idx) => {
          if (idx >= maxElements) return;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return;

          const style = window.getComputedStyle(el);
          const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
          if (!isVisible) return;

          const tag = el.tagName.toLowerCase();
          const text = el.textContent?.trim().substring(0, 150) || '';

          let label = '';
          if (el.id) {
            const labelEl = document.querySelector(`label[for="${el.id}"]`);
            if (labelEl) label = labelEl.textContent.trim();
          }
          if (!label && el.placeholder) label = el.placeholder;
          if (!label && el.getAttribute('aria-label')) label = el.getAttribute('aria-label');
          if (!label && el.getAttribute('aria-labelledby')) {
            const labelId = el.getAttribute('aria-labelledby');
            const labelEl = document.getElementById(labelId);
            if (labelEl) label = labelEl.textContent.trim();
          }
          if (!label && el.getAttribute('title')) label = el.getAttribute('title');

          // Get parent form info
          const parentForm = el.closest('form');
          const formInfo = parentForm ? {
            formAction: parentForm.action || '',
            formMethod: parentForm.method || 'get',
            formId: parentForm.id || '',
          } : null;

          elements.push({
            index: idx + 1,
            tag,
            type: el.type || '',
            role: el.getAttribute('role') || '',
            text,
            label,
            ariaLabel: el.getAttribute('aria-label') || '',
            placeholder: el.placeholder || '',
            name: el.name || '',
            id: el.id || '',
            className: el.className || '',
            href: el.href || '',
            src: el.src || '',
            value: el.value?.substring(0, 100) || '',
            checked: el.checked || false,
            disabled: el.disabled || false,
            required: el.required || false,
            position: { top: Math.round(rect.top), left: Math.round(rect.left) },
            size: { width: Math.round(rect.width), height: Math.round(rect.height) },
            inViewport: rect.top >= 0 && rect.top <= window.innerHeight && rect.left >= 0 && rect.left <= window.innerWidth,
            dataTestId: el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-cy') || '',
            formInfo,
          });
        });

        const landmarks = {};
        ['header', 'nav', 'main', 'article', 'aside', 'footer', 'form', 'search', 'dialog'].forEach(tag => {
          const els = document.querySelectorAll(tag);
          if (els.length > 0) landmarks[tag] = els.length;
        });

        const forms = Array.from(document.querySelectorAll('form')).map((form, i) => ({
          index: i,
          action: form.action || '',
          method: form.method || 'get',
          id: form.id || '',
          fields: Array.from(form.querySelectorAll('input, select, textarea, button')).map(f => ({
            tag: f.tagName.toLowerCase(),
            type: f.type || '',
            name: f.name || '',
            id: f.id || '',
            required: f.required || false,
            label: f.placeholder || f.getAttribute('aria-label') || '',
          })),
        }));

        // Detect common UI patterns
        const patterns = {
          hasModal: !!document.querySelector('[role="dialog"], .modal, [class*="modal"], [class*="overlay"]'),
          hasDropdown: !!document.querySelector('[role="menu"], [class*="dropdown"], select'),
          hasSearch: !!document.querySelector('input[type="search"], [role="searchbox"], [class*="search"]'),
          hasPagination: !!document.querySelector('[class*="pagination"], [class*="page"]'),
          hasLoginForm: !!document.querySelector('input[type="password"]'),
          hasCart: !!document.querySelector('[class*="cart"], [class*="basket"]'),
        };

        return {
          pageMeta: {
            title: document.title,
            url: window.location.href,
            description: document.querySelector('meta[name="description"]')?.content || '',
            viewport: { width: window.innerWidth, height: window.innerHeight },
            scrollPosition: { x: window.scrollX, y: window.scrollY },
            totalHeight: document.documentElement.scrollHeight,
            language: document.documentElement.lang || 'unknown',
          },
          elements,
          landmarks,
          forms: forms.slice(0, 5),
          elementCount: all.length,
          patterns,
        };
      }),
      page.screenshot({ type: 'png', fullPage: false }),
    ]);

    return {
      domData,
      screenshot: screenshot.toString('base64'),
      timestamp: new Date().toISOString(),
    };
  }, 'getDeepPageSnapshot');
}

// ─── Smart Action Execution with Self-Healing ────────────────────────
async function executeBrowserAction(action) {
  return withRetry(async () => {
    if (!page) throw new Error('Browser not initialized');

    const { type, selector, text, url, x, y, key, options = {} } = action;
    const result = { success: true, timestamp: new Date().toISOString() };

    switch (type) {
      case 'navigate':
        await page.goto(url, { waitUntil: 'networkidle' });
        break;
      case 'click':
        try {
          await page.click(selector, { timeout: 5000 });
        } catch (e) {
          // Fallback: click by text if selector fails
          const elements = await page.getByText(selector).all();
          if (elements.length > 0) {
            await elements[0].click();
          } else {
            throw e;
          }
        }
        break;
      case 'type':
        await page.fill(selector, text);
        break;
      case 'type_slow':
        await page.type(selector, text, { delay: 50 });
        break;
      case 'clear':
        await page.fill(selector, '');
        break;
      case 'scroll':
        await page.mouse.wheel(x, y);
        break;
      case 'scroll_to':
        await page.locator(selector).scrollIntoViewIfNeeded();
        break;
      case 'press':
        await page.press(selector, key);
        break;
      case 'hover':
        await page.hover(selector);
        break;
      case 'select':
        await page.selectOption(selector, text);
        break;
      case 'screenshot':
        result.screenshot = (await page.screenshot({ type: 'png', fullPage: !!options.fullPage })).toString('base64');
        break;
      case 'wait':
        await page.waitForTimeout(parseInt(text) || 2000);
        break;
      case 'evaluate':
        result.data = await page.evaluate(text);
        break;
      case 'find_and_click':
        await page.getByText(text, { exact: false }).first().click();
        break;
    }

    return result;
  }, `executeBrowserAction(${action.type})`);
}

// ─── Enhanced Function Declarations ──────────────────────────────────
const functionDeclarations = [
  {
    name: 'click_element',
    description: 'Click an element by CSS selector. If selector fails, the system will try text-based fallback automatically.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector (e.g., "button#submit", "a[href=\"/login\"]", "input[name=\"email\"]")' },
        reason: { type: 'string', description: 'Why you are clicking this element - helps debugging' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'type_text',
    description: 'Type text into an input field. Automatically clears existing content.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of input field' },
        text: { type: 'string', description: 'Text to type' },
        slow: { type: 'boolean', description: 'Type slowly (50ms/char) for human-like behavior' },
      },
      required: ['selector', 'text'],
    },
  },
  {
    name: 'clear_field',
    description: 'Clear an input field or textarea.',
    parameters: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'CSS selector' } },
      required: ['selector'],
    },
  },
  {
    name: 'navigate_to',
    description: 'Navigate to a specific URL.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL (e.g., https://example.com)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'scroll_page',
    description: 'Scroll page by amount. Positive Y = down, negative = up.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Horizontal pixels (default: 0)' },
        y: { type: 'number', description: 'Vertical pixels (500 moderate, 1000 large)' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'scroll_to_element',
    description: 'Scroll until element is visible in viewport.',
    parameters: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'CSS selector' } },
      required: ['selector'],
    },
  },
  {
    name: 'press_key',
    description: 'Press a keyboard key.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Element to focus (default: body)' },
        key: { type: 'string', enum: ['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Delete', 'Space', 'Control+a', 'Control+c', 'Control+v'], description: 'Key to press' },
      },
      required: ['selector', 'key'],
    },
  },
  {
    name: 'hover_element',
    description: 'Hover over element to trigger dropdowns/tooltips.',
    parameters: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'CSS selector' } },
      required: ['selector'],
    },
  },
  {
    name: 'select_option',
    description: 'Select an option from dropdown.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Select element CSS' },
        value: { type: 'string', description: 'Option value or label' },
      },
      required: ['selector', 'value'],
    },
  },
  {
    name: 'take_screenshot',
    description: 'Capture screenshot to verify visual state after actions.',
    parameters: {
      type: 'object',
      properties: { fullPage: { type: 'boolean', description: 'Capture full page vs viewport only' } },
    },
  },
  {
    name: 'wait',
    description: 'Wait for page load/animations/network requests.',
    parameters: {
      type: 'object',
      properties: { milliseconds: { type: 'number', description: 'Duration in milliseconds' } },
      required: ['milliseconds'],
    },
  },
  {
    name: 'evaluate_script',
    description: 'Execute JavaScript for complex operations not covered by other functions.',
    parameters: {
      type: 'object',
      properties: { script: { type: 'string', description: 'JavaScript code to execute' } },
      required: ['script'],
    },
  },
  {
    name: 'find_and_click',
    description: 'Find element by visible text and click it. Use when CSS selector is uncertain or dynamic.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Exact or partial visible text of the element' },
      },
      required: ['text'],
    },
  },
];

// ─── Ultra-Advanced System Prompt for Gemini 3.1 Flash Lite ─────────
const SYSTEM_PROMPT = `أنت وكيل أتمتة متصفح ذكي فائق التطور (Afnan AI v3). مهمتك تنفيذ المهام المعقدة بتقسيمها تلقائياً إلى خطوات صغيرة وتنفيذها بالتتابع دون انتظار المستخدم في كل خطوة.

## المبدأ الأساسي: التخطيط التلقائي (Auto-Planning)
عند استلام مهمة (مثلاً: "افتح يوتيوب وابحث عن قرآن وحمل الفيديو"):
1. قم بإنشاء خطة كاملة في ذهنك.
2. ابدأ بتنفيذ الخطوة الأولى فوراً (مثلاً: navigate_to يوتيوب).
3. بعد نجاح الخطوة، انتقل للخطوة التالية تلقائياً (مثلاً: type_text في خانة البحث).
4. استمر حتى تكتمل المهمة النهائية.

## التعامل مع أفعال المستخدم اليدوية:
المستخدم قد يتدخل يدوياً في المتصفح. سيتم تزويدك بسجل لأفعال المستخدم (User Manual Actions). 
- يجب أن تدمج هذه الأفعال في خطتك. 
- إذا قام المستخدم بخطوة كنت تنوي القيام بها، انتقل للخطوة التالية مباشرة.
- إذا قام المستخدم بتغيير مسار المهمة، عدل خطتك لتتوافق مع الوضع الجديد.

## قواعد العمل:
- **التنفيذ المتتابع**: يمكنك استدعاء عدة وظائف في رد واحد إذا كان ذلك منطقياً، أو الاعتماد على حلقة الوكيل للاستمرار.
- **التحقق**: خذ screenshot بعد الخطوات المحورية للتأكد من نجاحها.
- **المرونة**: إذا فشل selector، لا تتوقف، استخدم find_and_click أو ابحث عن بديل.

لغة الرد: العربية دائماً.`;

// ─── Conversation Memory with Semantic Compression ─────────────────────
function getConversationContext(socketId) {
  if (!conversationStore.has(socketId)) {
    conversationStore.set(socketId, { history: [], maxContext: 30, summary: '' });
  }
  return conversationStore.get(socketId);
}

function addToConversation(socketId, role, content, parts = []) {
  const conv = getConversationContext(socketId);
  conv.history.push({ role, content, parts, timestamp: new Date().toISOString() });

  if (conv.history.length > conv.maxContext * 2) {
    const toSummarize = conv.history.slice(0, 4);
    const summary = toSummarize.map(h => `${h.role}: ${h.content.substring(0, 100)}`).join(' | ');
    conv.summary = (conv.summary ? conv.summary + ' | ' : '') + summary;
    conv.history = conv.history.slice(4);
  }
}

function buildGeminiContents(socketId, currentMessage, base64Screenshot) {
  const conv = getConversationContext(socketId);
  const userActions = userActionLog.get(socketId) || [];
  const contents = [];

  contents.push({ role: 'user', parts: [{ text: SYSTEM_PROMPT }] });
  contents.push({ role: 'model', parts: [{ text: 'تم الاستلام. سأقوم بتقسيم المهام وتنفيذها خطوة بخطوة مع مراعاة تدخلاتك اليدوية.' }] });

  if (conv.summary) {
    contents.push({ role: 'user', parts: [{ text: `ملخص المحادثات السابقة: ${conv.summary}` }] });
  }

  // Add user manual actions context
  if (userActions.length > 0) {
    const actionsText = userActions.map(a => `[User Manual Action] ${a.type} on ${a.target} at ${a.timestamp}`).join('\n');
    contents.push({ role: 'user', parts: [{ text: `تنبيه: قام المستخدم بالأفعال اليدوية التالية مؤخراً:\n${actionsText}` }] });
    userActionLog.set(socketId, []); // Clear after sending to context
  }

  for (const entry of conv.history) {
    contents.push({
      role: entry.role,
      parts: entry.parts.length > 0 ? entry.parts : [{ text: entry.content }],
    });
  }

  const currentParts = [{ text: currentMessage }];
  if (base64Screenshot) {
    currentParts.push({
      inlineData: { mimeType: 'image/png', data: base64Screenshot },
    });
  }
  contents.push({ role: 'user', parts: currentParts });

  return contents;
}

function cleanupConversation(socketId) {
  conversationStore.delete(socketId);
  userActionLog.delete(socketId);
}

// ─── Gemini Response Processing ────────────────────────────────────────
async function processGeminiResponse(response, socketId) {
  const result = response.response;
  const functionCalls = result.functionCalls();
  const textParts = [];

  for (const part of result.candidates?.[0]?.content?.parts || []) {
    if (part.text) textParts.push(part.text);
  }

  const executionResults = [];

  if (functionCalls && functionCalls.length > 0) {
    logger.info(`Executing ${functionCalls.length} function call(s)`);

    for (const call of functionCalls) {
      let actionResult;
      try {
        switch (call.name) {
          case 'click_element':
            actionResult = await executeBrowserAction({ type: 'click', selector: call.args.selector });
            break;
          case 'type_text':
            actionResult = await executeBrowserAction({ type: call.args.slow ? 'type_slow' : 'type', selector: call.args.selector, text: call.args.text });
            break;
          case 'clear_field':
            actionResult = await executeBrowserAction({ type: 'clear', selector: call.args.selector });
            break;
          case 'navigate_to':
            actionResult = await executeBrowserAction({ type: 'navigate', url: call.args.url });
            break;
          case 'scroll_page':
            actionResult = await executeBrowserAction({ type: 'scroll', x: call.args.x || 0, y: call.args.y || 0 });
            break;
          case 'scroll_to_element':
            actionResult = await executeBrowserAction({ type: 'scroll_to', selector: call.args.selector });
            break;
          case 'press_key':
            actionResult = await executeBrowserAction({ type: 'press', selector: call.args.selector || 'body', key: call.args.key });
            break;
          case 'hover_element':
            actionResult = await executeBrowserAction({ type: 'hover', selector: call.args.selector });
            break;
          case 'select_option':
            actionResult = await executeBrowserAction({ type: 'select', selector: call.args.selector, text: call.args.value });
            break;
          case 'take_screenshot':
            actionResult = await executeBrowserAction({ type: 'screenshot', options: { fullPage: call.args.fullPage } });
            break;
          case 'wait':
            actionResult = await executeBrowserAction({ type: 'wait', text: String(call.args.milliseconds) });
            break;
          case 'evaluate_script':
            actionResult = await executeBrowserAction({ type: 'evaluate', text: call.args.script });
            break;
          case 'find_and_click':
            actionResult = await executeBrowserAction({ type: 'find_and_click', text: call.args.text });
            break;
          default:
            actionResult = { success: false, error: `Unknown function: ${call.name}` };
        }
      } catch (error) {
        actionResult = { success: false, error: error.message };
        logger.error(`Action ${call.name} failed: ${error.message}`);
      }

      executionResults.push({ function: call.name, args: call.args, result: actionResult });

      io.to(socketId).emit('action_executed', {
        action: call.name,
        args: call.args,
        result: actionResult,
        timestamp: new Date().toISOString(),
      });
    }

    // Send updated state after actions
    try {
      const snapshot = await getDeepPageSnapshot();
      if (snapshot) {
        io.to(socketId).emit('page_state_update', {
          screenshot: snapshot.screenshot,
          domData: snapshot.domData,
          timestamp: snapshot.timestamp,
        });
      }
    } catch (error) {
      logger.error(`Screenshot Update Error: ${error.message}`);
    }
  }

  return {
    text: textParts.join('\n') || 'تم تنفيذ الإجراء بنجاح',
    functionCalls: executionResults,
    hasActions: executionResults.length > 0,
  };
}

// ─── Main Agent Loop (Ultra Advanced with Auto-Continuation) ──────────
async function runAgentLoop(userMessage, socket, isAutoContinuation = false) {
  const socketId = socket.id;
  const taskId = isAutoContinuation ? currentTaskId : uuidv4();
  currentTaskId = taskId;

  try {
    checkCircuitBreaker();

    if (!isAutoContinuation && isAgentActive) {
      socket.emit('warning', { message: 'الوكيل مشغول بتنفيذ مهمة سابقة. يرجى الانتظار...' });
      return;
    }

    isAgentActive = true;
    socket.emit('agent_status', { status: 'thinking', message: isAutoContinuation ? 'جاري الانتقال للخطوة التالية...' : 'جاري تحليل الطلب والتخطيط...' });
    
    // Capture deep snapshot
    const snapshot = await getDeepPageSnapshot();
    if (!snapshot) {
      socket.emit('error', { message: 'Failed to capture page state' });
      isAgentActive = false;
      return;
    }

    // Build context
    const contents = buildGeminiContents(socketId, userMessage, snapshot.screenshot);

    const model = genAI.getGenerativeModel({
      model: 'gemini-3.1-flash-lite',
      tools: [{ functionDeclarations }],
      safetySettings,
    });

    const result = await withRetry(async () => {
      return await model.generateContent({
        contents,
        generationConfig: {
          temperature: 0.1,
          topP: 0.95,
          topK: 40,
          maxOutputTokens: 8192,
        },
      });
    }, 'Gemini API call');

    const processed = await processGeminiResponse(result, socketId);

    // Store in memory
    if (!isAutoContinuation) {
      addToConversation(socketId, 'user', userMessage, [{ text: userMessage }]);
    }
    addToConversation(socketId, 'model', processed.text, []);

    // Emit response
    socket.emit('bot_message', {
      text: processed.text,
      hasActions: processed.hasActions,
      actions: processed.functionCalls,
      taskId,
      timestamp: new Date().toISOString(),
    });

    // AUTO-CONTINUATION LOGIC
    // If the model called a function, we automatically trigger another loop to see what's next
    if (processed.hasActions) {
      logger.info(`Auto-continuing task ${taskId} for next step...`);
      setTimeout(() => runAgentLoop("تابع تنفيذ المهمة للوصول للهدف النهائي.", socket, true), 1000);
    } else {
      isAgentActive = false;
      currentTaskId = null;
      socket.emit('agent_status', { status: 'idle', message: 'اكتملت المهمة' });
    }

    recordSuccess();

  } catch (error) {
    recordFailure();
    logger.error(`[Task ${taskId}] Error: ${error.message}`);
    socket.emit('error', {
      message: `خطأ في الوكيل: ${error.message}`,
      taskId,
    });
    isAgentActive = false;
    currentTaskId = null;
  }
}

// ─── Routes ──────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/health', (req, res) => {
  res.json({ success: true, status: 'healthy', browserConnected: !!browser, uptime: process.uptime() });
});

// ─── Socket.IO Handlers ──────────────────────────────────────────────
io.on('connection', (socket) => {
  logger.info(`Client connected: ${socket.id}`);

  socket.emit('connection_ack', { socketId: socket.id, browserConnected: !!browser });

  socket.on('initialize_browser', async () => {
    try {
      await initializeBrowser();
      socket.emit('browser_initialized', { success: true });
    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('send_message', async (data) => {
    await runAgentLoop(data.message.trim(), socket);
  });

  // NEW: Log manual user actions
  socket.on('log_user_action', (data) => {
    const { type, target } = data;
    const actions = userActionLog.get(socket.id) || [];
    actions.push({ type, target, timestamp: new Date().toISOString() });
    userActionLog.set(socket.id, actions);
    logger.info(`User Manual Action: ${type} on ${target}`);
  });

  socket.on('disconnect', () => {
    cleanupConversation(socket.id);
  });
});

// ─── Server Startup ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3005;
server.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT}`);
  try { await initializeBrowser(); } catch (e) {}
});

process.on('SIGINT', async () => {
  await closeBrowser();
  server.close(() => { process.exit(0); });
});
