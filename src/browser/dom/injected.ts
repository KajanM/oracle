export const INJECTED_ORACLE_DOM_HELPERS = String.raw`(() => {
  if (typeof window === 'undefined') {
    return;
  }

  if (window.__oracle && window.__oracle.version === 'dom-v1') {
    return;
  }

  window.__oracleManifest = window.__oracleManifest || {};

  const ORACLE_ATTR = 'data-oracle-id';
  const cache = new Map();
  let sequence = 0;

  function hashText(input) {
    let hash = 5381;
    for (let index = 0; index < input.length; index += 1) {
      hash = ((hash << 5) + hash) ^ input.charCodeAt(index);
    }
    return (hash >>> 0).toString(36);
  }

  function safeClosest(node, selector) {
    if (!node || typeof node.closest !== 'function') {
      return null;
    }
    try {
      return node.closest(selector);
    } catch {
      return null;
    }
  }

  function isElementVisible(node) {
    if (!(node instanceof Element)) {
      return false;
    }
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }
    const style = window.getComputedStyle(node);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  function isElementEnabled(node) {
    if (!(node instanceof Element)) {
      return false;
    }
    if ('disabled' in node && node.disabled) {
      return false;
    }
    const ariaDisabled = node.getAttribute('aria-disabled');
    return ariaDisabled !== 'true';
  }

  function isElementEditable(node) {
    if (!(node instanceof Element)) {
      return false;
    }
    if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
      return !node.disabled && !node.readOnly;
    }
    return node.isContentEditable || node.getAttribute('contenteditable') === 'true';
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function matchesPattern(value, pattern) {
    const candidate = String(value || '');
    if (!pattern || typeof pattern !== 'object') {
      return false;
    }
    if (pattern.kind === 'substring') {
      return candidate.toLowerCase().includes(String(pattern.value || '').toLowerCase());
    }
    if (pattern.kind === 'regex') {
      try {
        return new RegExp(pattern.source, pattern.flags || '').test(candidate);
      } catch {
        return false;
      }
    }
    return false;
  }

  function collectElements(root, selector) {
    const base = root instanceof Element || root instanceof Document ? root : document;
    try {
      return Array.from(base.querySelectorAll(selector));
    } catch {
      return [];
    }
  }

  function getSurfaceRoot(surface) {
    if (surface === 'composer' || surface === 'attachments') {
      return document.querySelector('form') || document.body;
    }
    if (surface === 'modelPicker') {
      const trigger = document.querySelector('[data-testid="model-switcher-dropdown-button"]');
      return safeClosest(trigger, 'header, div, form, nav') || document.body;
    }
    if (surface === 'assistant') {
      return (
        findLatestAssistantTurn() ||
        document.querySelector('main') ||
        document.body
      );
    }
    return document.body;
  }

  function surfaceFingerprint(surface) {
    const root = getSurfaceRoot(surface);
    const values = [];
    if (root instanceof Element) {
      values.push(root.tagName);
      values.push(root.getAttribute('data-testid') || '');
      values.push(root.getAttribute('role') || '');
      values.push(root.getAttribute('aria-label') || '');
    }
    const elements = collectElements(root, '*').slice(0, 200);
    for (const element of elements) {
      values.push(element.tagName);
      values.push(element.getAttribute('data-testid') || '');
      values.push(element.getAttribute('role') || '');
      values.push(element.getAttribute('aria-label') || '');
    }
    return surface + ':' + hashText(values.join('|'));
  }

  function mark(node, key) {
    if (!(node instanceof Element)) {
      return '';
    }
    const current = node.getAttribute(ORACLE_ATTR);
    if (current) {
      return current;
    }
    sequence += 1;
    const id = 'oracle-' + String(sequence) + '-' + hashText(key + ':' + Date.now() + ':' + sequence);
    node.setAttribute(ORACLE_ATTR, id);
    return id;
  }

  function buildCacheFingerprint(locator) {
    if (!locator) {
      return 'none';
    }
    if (locator.cachePolicy === 'fingerprint') {
      return surfaceFingerprint(locator.surface);
    }
    if (locator.cachePolicy === 'navigation') {
      return String(location.pathname) + '|' + String(document.readyState);
    }
    return 'none';
  }

  function getCached(locator, key, refresh) {
    if (!locator || locator.cachePolicy === 'none' || refresh) {
      return null;
    }
    const entry = cache.get(key);
    if (!entry || !(entry.node instanceof Element) || !entry.node.isConnected) {
      return null;
    }
    const currentFingerprint = buildCacheFingerprint(locator);
    if (locator.cachePolicy === 'fingerprint' && currentFingerprint !== entry.fingerprint) {
      return null;
    }
    return {
      ok: true,
      key,
      oracleId: mark(entry.node, key),
      strategyId: entry.strategyId,
      score: 10_000,
      fingerprint: entry.fingerprint,
      tried: [],
    };
  }

  function strategyIdFor(key, strategy, index) {
    return key + ':' + strategy.kind + ':' + index;
  }

  function resolveScope(scopeKey, opts, stack) {
    if (!scopeKey) {
      return null;
    }
    const resolved = resolveInternal(scopeKey, opts, stack);
    if (!resolved.ok || !resolved.oracleId) {
      return null;
    }
    return document.querySelector('[' + ORACLE_ATTR + '="' + resolved.oracleId + '"]');
  }

  function scoreNode(node, strategyWeight) {
    let score = strategyWeight;
    if (isElementVisible(node)) {
      score += 10;
    }
    if (isElementEnabled(node)) {
      score += 4;
    }
    if (isElementEditable(node)) {
      score += 4;
    }
    if (node instanceof Element && node.querySelector('[data-testid^="model-switcher"]')) {
      score += 20;
    }
    return score;
  }

  function applyPredicates(node, predicates, opts, stack) {
    for (const predicate of predicates || []) {
      if (!predicate || typeof predicate !== 'object') {
        continue;
      }
      if (predicate.kind === 'visible' && !isElementVisible(node)) {
        return false;
      }
      if (predicate.kind === 'enabled' && !isElementEnabled(node)) {
        return false;
      }
      if (predicate.kind === 'editable' && !isElementEditable(node)) {
        return false;
      }
      if (predicate.kind === 'inside') {
        const scopeNode = resolveScope(predicate.locatorKey, opts, stack);
        if (!(scopeNode instanceof Element) || !scopeNode.contains(node)) {
          return false;
        }
      }
    }
    return true;
  }

  function runCssStrategy(key, strategy, scopeNode) {
    const base = scopeNode instanceof Element ? scopeNode : document;
    let nodes = collectElements(base, strategy.selector);
    if (key === 'model.menu' && strategy.selector === '[role="menu"]') {
      nodes = nodes.filter((node) => node.querySelector('[data-testid^="model-switcher"]'));
    }
    return nodes;
  }

  function runAttrStrategy(strategy, scopeNode) {
    const selector = '[' + String(strategy.attr || '').replace(/"/g, '\\"') + ']';
    return collectElements(scopeNode instanceof Element ? scopeNode : document, selector).filter((node) =>
      matchesPattern(node.getAttribute(strategy.attr), strategy.pattern),
    );
  }

  function runTextStrategy(strategy, scopeNode) {
    return collectElements(scopeNode instanceof Element ? scopeNode : document, strategy.selector).filter((node) =>
      matchesPattern(normalizeText(node.textContent), strategy.pattern),
    );
  }

  function findComposerRoot(scopeNode) {
    const scopedPrompt = scopeNode instanceof Element ? scopeNode.querySelector('#prompt-textarea') : null;
    const prompt = scopedPrompt || document.querySelector('#prompt-textarea');
    const fromPrompt = safeClosest(prompt, 'form');
    if (fromPrompt) {
      return fromPrompt;
    }
    const form = scopeNode instanceof Element && scopeNode.matches('form')
      ? scopeNode
      : document.querySelector('form');
    return form || null;
  }

  function findEditableTextbox(scopeNode) {
    const base = scopeNode instanceof Element ? scopeNode : document;
    const candidates = [
      ...collectElements(base, '[contenteditable="true"]'),
      ...collectElements(base, 'textarea'),
      ...collectElements(base, 'input[type="text"]'),
    ];
    return candidates.find((node) => isElementVisible(node) && isElementEditable(node)) || null;
  }

  function pickBestFileInput(scopeNode) {
    const base = scopeNode instanceof Element ? scopeNode : document;
    const candidates = collectElements(base, 'input[type="file"]');
    if (candidates.length === 0) {
      return null;
    }
    const sorted = candidates.slice().sort((left, right) => {
      const leftAccept = left.getAttribute('accept');
      const rightAccept = right.getAttribute('accept');
      const leftScore = leftAccept ? 0 : 10;
      const rightScore = rightAccept ? 0 : 10;
      return rightScore - leftScore;
    });
    return sorted[0] || null;
  }

  function findModelTrigger(scopeNode) {
    const base = scopeNode instanceof Element ? scopeNode : document;
    const buttons = collectElements(base, 'button[aria-haspopup="menu"], button');
    for (const button of buttons) {
      const label = normalizeText(button.getAttribute('aria-label') || button.textContent || '');
      if (!label) {
        continue;
      }
      if (label.toLowerCase().includes('gpt') || label.toLowerCase().includes('model')) {
        return button;
      }
    }
    return null;
  }

  function findLatestAssistantTurn(scopeNode) {
    const base = scopeNode instanceof Element ? scopeNode : document;
    const candidates = [
      ...collectElements(base, 'section[data-turn="assistant"]'),
      ...collectElements(base, 'article[data-turn="assistant"]'),
      ...collectElements(base, 'section[data-message-author-role="assistant"]'),
      ...collectElements(base, 'article[data-message-author-role="assistant"]'),
      ...collectElements(base, '[data-message-author-role="assistant"]'),
      ...collectElements(base, '[data-turn="assistant"]'),
    ];
    const visible = candidates.filter((node) => isElementVisible(node));
    return visible[visible.length - 1] || candidates[candidates.length - 1] || null;
  }

  const probes = {
    findComposerRoot,
    findEditableTextbox,
    pickBestFileInput,
    findModelTrigger,
    findLatestAssistantTurn,
  };

  function runProbeStrategy(strategy, scopeNode) {
    const probe = probes[strategy.probe];
    if (typeof probe !== 'function') {
      return [];
    }
    const result = probe(scopeNode);
    if (Array.isArray(result)) {
      return result.filter((node) => node instanceof Element);
    }
    return result instanceof Element ? [result] : [];
  }

  function resolveInternal(key, opts, stack) {
    const manifest = window.__oracleManifest || {};
    const locator = manifest[key];
    const refresh = Boolean(opts && opts.refresh);
    if (!locator) {
      return { ok: false, key, tried: [] };
    }

    if (stack && stack.has(key)) {
      return { ok: false, key, tried: [] };
    }

    const cached = getCached(locator, key, refresh);
    if (cached) {
      return cached;
    }

    const nextStack = stack || new Set();
    nextStack.add(key);

    const strategies = Array.isArray(locator.strategies)
      ? locator.strategies.slice().sort((left, right) => right.weight - left.weight)
      : [];

    const tried = [];
    let winner = null;

    for (let index = 0; index < strategies.length; index += 1) {
      const strategy = strategies[index];
      const traceId = strategyIdFor(key, strategy, index);
      const scopeNode = resolveScope(strategy.scope, opts, nextStack);
      let matches = [];
      if (strategy.kind === 'css') {
        matches = runCssStrategy(key, strategy, scopeNode);
      } else if (strategy.kind === 'attr') {
        matches = runAttrStrategy(strategy, scopeNode);
      } else if (strategy.kind === 'text') {
        matches = runTextStrategy(strategy, scopeNode);
      } else if (strategy.kind === 'probe') {
        matches = runProbeStrategy(strategy, scopeNode);
      }

      let bestScore = 0;
      for (const node of matches) {
        if (!(node instanceof Element)) {
          continue;
        }
        if (!applyPredicates(node, locator.predicates || [], opts, nextStack)) {
          continue;
        }
        const score = scoreNode(node, strategy.weight);
        if (score > bestScore) {
          bestScore = score;
        }
        if (!winner || score > winner.score) {
          winner = { node, score, strategyId: traceId };
        }
      }
      tried.push({
        id: traceId,
        matches: matches.length,
        bestScore,
      });
    }

    nextStack.delete(key);

    const fingerprint = buildCacheFingerprint(locator);
    if (!winner) {
      return { ok: false, key, fingerprint, tried };
    }

    const oracleId = mark(winner.node, key);
    if (locator.cachePolicy !== 'none') {
      cache.set(key, {
        node: winner.node,
        strategyId: winner.strategyId,
        fingerprint,
      });
    }

    return {
      ok: true,
      key,
      oracleId,
      strategyId: winner.strategyId,
      score: winner.score,
      fingerprint,
      tried,
    };
  }

  function invalidateSurface(surface) {
    const manifest = window.__oracleManifest || {};
    for (const [key] of cache.entries()) {
      const locator = manifest[key];
      if (locator && locator.surface === surface) {
        cache.delete(key);
      }
    }
    return true;
  }

  function bootstrap(keys) {
    const health = {};
    let ok = true;
    for (const key of keys || []) {
      const resolved = resolveInternal(key, { refresh: true }, new Set());
      health[key] = resolved;
      if (!resolved.ok) {
        ok = false;
      }
    }
    return { ok, health };
  }

  window.__oracle = {
    version: 'dom-v1',
    cache,
    surfaceFingerprint,
    mark,
    resolve(key, opts) {
      return resolveInternal(key, opts || {}, new Set());
    },
    invalidateSurface,
    bootstrap,
  };
})();`;
