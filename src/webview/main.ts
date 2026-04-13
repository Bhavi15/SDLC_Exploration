// Webview client script - runs in the webview DOM, not Node.js
declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

(function () {
  const vscode = acquireVsCodeApi();

  // DOM refs
  const $modelPicker = document.getElementById('model-picker') as HTMLSelectElement;
  const $kbList = document.getElementById('kb-list')!;
  const $inboxList = document.getElementById('inbox-list')!;
  const $rawList = document.getElementById('raw-list')!;
  const $kbCount = document.getElementById('kb-count')!;
  const $inboxCount = document.getElementById('inbox-count')!;
  const $rawCount = document.getElementById('raw-count')!;
  const $imgZone = document.getElementById('img-zone')!;
  const $imgPreview = document.getElementById('img-preview') as HTMLImageElement;
  const $imgHint = document.getElementById('img-hint')!;
  const $imgName = document.getElementById('img-name')!;
  const $btnRemoveImg = document.getElementById('btn-remove-img')!;
  const $prompt = document.getElementById('prompt') as HTMLTextAreaElement;
  const $genFiles = document.getElementById('gen-files')!;
  const $genList = document.getElementById('gen-list')!;
  const $genCount = document.getElementById('gen-count')!;
  const $status = document.getElementById('status')!;

  let attachedBase64: string | undefined;
  let attachedMime: string | undefined;
  let streamBuffer = '';
  let streamCharCount = 0;
  let streamFramework = '';
  let streamFiles: string[] = [];

  // Mascot state
  const $mascot = document.getElementById('mascot')!;
  const $mascotMood = document.getElementById('mascot-mood')!;
  type MascotState = 'idle' | 'thinking' | 'celebrating' | 'sad';
  const idleMoods: Record<string, string> = {
    dev: 'Ready to code',
    kb:  'Browsing your docs',
    ba:  'Planning ahead',
    qa:  'On standby',
  };
  const transientMoods: Record<Exclude<MascotState, 'idle'>, string> = {
    thinking:    'Thinking hard\u2026',
    celebrating: 'Looks amazing!',
    sad:         'Oops, try again',
  };
  let currentModule = 'dev';
  let mascotTimer: ReturnType<typeof setTimeout> | undefined;

  function setMascot(state: MascotState, autoRevertMs?: number) {
    if (mascotTimer) { clearTimeout(mascotTimer); mascotTimer = undefined; }
    $mascot.className = 'mascot ' + state + ' mod-' + currentModule;
    $mascotMood.textContent = state === 'idle'
      ? (idleMoods[currentModule] || 'Ready')
      : transientMoods[state];
    if (autoRevertMs && state !== 'idle') {
      mascotTimer = setTimeout(() => setMascot('idle'), autoRevertMs);
    }
  }

  // Module switching
  const $views: Record<string, HTMLElement> = {
    dev: document.getElementById('view-dev')!,
    kb:  document.getElementById('view-kb')!,
    ba:  document.getElementById('view-ba')!,
    qa:  document.getElementById('view-qa')!,
  };
  const $moduleCards = Array.from(document.querySelectorAll<HTMLButtonElement>('.module-card'));
  function setModule(id: string) {
    if (!$views[id]) { return; }
    for (const [k, el] of Object.entries($views)) { el.hidden = k !== id; }
    $moduleCards.forEach(c => c.classList.toggle('active', c.dataset.module === id));
    currentModule = id;
    // Only refresh mascot pose if it's currently idle — don't interrupt transient states
    if ($mascot.classList.contains('idle')) { setMascot('idle'); }
    else { $mascot.className = $mascot.className.replace(/\bmod-\w+/g, '') + ' mod-' + id; }
    saveState({ module: id });
  }
  $moduleCards.forEach(c => c.addEventListener('click', () => setModule(c.dataset.module || 'dev')));

  // Theme toggle
  const $themeToggle = document.getElementById('theme-toggle')!;
  const $themeLabel = document.getElementById('theme-label')!;
  function setTheme(theme: 'dark' | 'light') {
    document.documentElement.setAttribute('data-theme', theme);
    $themeLabel.textContent = theme === 'dark' ? 'Light' : 'Dark';
    saveState({ theme });
  }
  $themeToggle.addEventListener('click', () => {
    const cur = (document.documentElement.getAttribute('data-theme') as 'dark' | 'light') || 'dark';
    setTheme(cur === 'dark' ? 'light' : 'dark');
  });

  function saveState(patch: Record<string, unknown>) {
    const prev = (vscode.getState() as Record<string, unknown>) || {};
    vscode.setState({ ...prev, ...patch });
  }

  const savedState = (vscode.getState() as { theme?: 'dark' | 'light'; module?: string } | null) || {};
  setTheme(savedState.theme || 'dark');
  setModule(savedState.module || 'dev');

  // --- Event listeners ---

  $modelPicker.addEventListener('change', () => {
    vscode.postMessage({ type: 'selectModel', modelId: $modelPicker.value });
  });

  document.getElementById('btn-add')!.addEventListener('click', () =>
    vscode.postMessage({ type: 'addFiles' }));

  document.getElementById('btn-process')!.addEventListener('click', () => {
    setStatus('Processing inbox...', 'info');
    vscode.postMessage({ type: 'processInbox' });
  });

  $imgZone.addEventListener('click', () => {
    if (!attachedBase64) { vscode.postMessage({ type: 'attachImage' }); }
  });

  $btnRemoveImg.addEventListener('click', (e) => {
    e.stopPropagation();
    attachedBase64 = undefined;
    attachedMime = undefined;
    $imgPreview.style.display = 'none';
    $imgPreview.src = '';
    $imgHint.style.display = '';
    $imgName.style.display = 'none';
    $imgName.textContent = '';
    $btnRemoveImg.style.display = 'none';
    $imgZone.classList.remove('has-img');
  });

  document.getElementById('btn-generate')!.addEventListener('click', () => {
    const prompt = $prompt.value.trim();
    if (!prompt) { setStatus('Enter a prompt first.', 'error'); return; }
    resetStream();
    setStatus('Generating project...', 'info');
    vscode.postMessage({ type: 'generate', prompt, imageBase64: attachedBase64, imageMime: attachedMime });
  });

  document.getElementById('btn-refresh')!.addEventListener('click', () =>
    vscode.postMessage({ type: 'refresh' }));

  // --- Message handler ---

  window.addEventListener('message', (e: MessageEvent) => {
    const msg = e.data as { type: string } & Record<string, unknown>;
    switch (msg.type) {
      case 'models': {
        const models = msg.models as { id: string; name: string }[];
        const selectedId = msg.selectedId as string | undefined;
        $modelPicker.innerHTML = models.length
          ? models.map(m => `<option value="${esc(m.id)}"${m.id === selectedId ? ' selected' : ''}>${esc(m.name)}</option>`).join('')
          : '<option value="">No Copilot models found</option>';
        break;
      }
      case 'tree': {
        renderList($kbList, $kbCount, msg.kb as Item[], true);
        renderList($inboxList, $inboxCount, msg.inbox as Item[], false);
        renderList($rawList, $rawCount, msg.rawSources as Item[], false);
        const gen = msg.generated as Item[];
        if (gen?.length) { renderChips($genList, $genCount, gen.map(f => f.name)); $genFiles.style.display = ''; }
        break;
      }
      case 'imageAttached': {
        attachedBase64 = msg.base64 as string;
        attachedMime = msg.mime as string;
        $imgPreview.src = `data:${msg.mime};base64,${msg.base64}`;
        $imgPreview.style.display = 'block';
        $imgHint.style.display = 'none';
        $imgName.textContent = msg.name as string;
        $imgName.style.display = '';
        $btnRemoveImg.style.display = '';
        $imgZone.classList.add('has-img');
        break;
      }
      case 'streamStart': resetStream(); openStream(); setMascot('thinking'); break;
      case 'kbContext': renderKbContext(msg); break;
      case 'stream': appendStream(msg.chunk as string); break;
      case 'progress': setStatus(msg.message as string, 'info'); break;
      case 'status':   setStatus(msg.message as string, 'ok');   break;
      case 'error':    setStatus(msg.message as string, 'error'); closeStream(false); setMascot('sad', 4500); break;
      case 'errors':   setStatus((msg.errors as string[]).join(' | '), 'error'); closeStream(false); setMascot('sad', 4500); break;
      case 'generated': {
        const genFiles = msg.files as string[];
        const fw = (msg.framework as string) || streamFramework || 'unknown';
        renderChips($genList, $genCount, genFiles);
        $genFiles.style.display = '';

        // Build final stream body using the authoritative file list from server
        // (stream regex may not have caught all files if chunks were large)
        const finalFw = fw !== 'unknown' ? fw : streamFramework;
        let html = '';
        if (finalFw) {
          html += `<div class="sl-fw">&#9656;&nbsp;Framework: <strong>${esc(finalFw)}</strong></div>`;
        }
        genFiles.forEach(f => {
          html += `<div class="sl-file done"><span class="sl-ic">&#10003;</span>${esc(f)}</div>`;
        });

        // Summary line — group by extension
        const extGroups: Record<string, number> = {};
        genFiles.forEach(f => {
          const ext = f.includes('.') ? f.split('.').pop()! : 'other';
          extGroups[ext] = (extGroups[ext] || 0) + 1;
        });
        const groupSummary = Object.entries(extGroups)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([e, c]) => `${c} .${e}`)
          .join(', ');
        html += `<div class="sl-summary">&#10022;&nbsp;${genFiles.length} files &mdash; ${groupSummary}${groupSummary ? ' &mdash; ' : ''}run <code>npm install</code> then start the dev server.</div>`;

        // Preserve context section at the top
        const ctxSection = document.getElementById('sl-ctx-section');
        const ctxHtml = ctxSection ? ctxSection.outerHTML : '';
        $streamBody.innerHTML = ctxHtml + html;
        $streamBody.scrollTop = 0;
        $streamChars.textContent = genFiles.length + ' files';

        closeStream(true);
        setStatus(`Generated ${msg.fileCount} files (${fw}) — check Generated Files below`, 'ok');
        setMascot('celebrating', 4500);
        break;
      }
    }
  });

  // --- Helpers ---

  type Item = { name: string; kind: string };

  function renderList(container: Element, counter: Element, items: Item[], deletable = false) {
    counter.textContent = items?.length ? `(${items.length})` : '';
    if (!items?.length) { container.innerHTML = '<li class="empty">No files</li>'; return; }
    container.innerHTML = items.map(i => {
      const isDir = i.kind === 'dir';
      const icon = isDir ? '&#9656;' : '&bull;';
      const del = deletable && !isDir
        ? `<button class="file-del" data-name="${esc(i.name)}" title="Delete" type="button">&#10005;</button>`
        : '';
      return `<li title="${esc(i.name)}"><span class="file-ico">${icon}</span><span class="file-name">${esc(i.name)}</span>${del}</li>`;
    }).join('');
    if (deletable) {
      container.querySelectorAll<HTMLButtonElement>('.file-del').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const name = btn.dataset.name;
          if (name) { vscode.postMessage({ type: 'deleteKbFile', name }); }
        });
      });
    }
  }

  const $streamPanel = document.getElementById('stream-panel')!;
  const $streamBody  = document.getElementById('stream-body')!;
  const $streamLabel = document.getElementById('stream-label')!;
  const $streamChars = document.getElementById('stream-chars')!;
  const $streamPulse = document.getElementById('stream-pulse')!;

  function resetStream() {
    streamBuffer = '';
    streamCharCount = 0;
    streamFramework = '';
    streamFiles = [];
    $streamPanel.style.display = 'none';
    $streamBody.innerHTML = '';
    $streamChars.textContent = '';
    $streamLabel.textContent = 'Copilot is generating\u2026';
    $streamPulse.className = 'stream-pulse';
  }

  function openStream() {
    $streamPanel.style.display = '';
    $streamPulse.className = 'stream-pulse active';
    // Context section will be injected by kbContext message; placeholder for files
    $streamBody.innerHTML = '<div id="sl-ctx-section"></div><div class="sl-scanning" id="sl-files-placeholder"><span class="sl-dot"></span>Retrieving context\u2026</div>';
  }

  type KbContextMsg = {
    type: string;
    strategy: 'all' | 'tag-prefilter' | 'llm-routed';
    docs: Array<{ file: string; source: string; title: string; app: string }>;
    totalDocs: number;
    hasImage: boolean;
  };

  function renderKbContext(msg: Record<string, unknown>) {
    const m = msg as unknown as KbContextMsg;
    const strategyLabel: Record<string, string> = {
      'all': 'full KB',
      'tag-prefilter': 'tag match',
      'llm-routed': 'LLM routed',
    };
    const label = strategyLabel[m.strategy] || m.strategy;

    let html = `<div class="sl-ctx-header">`;
    html += `<span class="sl-ctx-badge">${esc(label)}</span>`;
    html += ` <span class="sl-ctx-count">${m.totalDocs} KB doc${m.totalDocs !== 1 ? 's' : ''} retrieved`;
    if (m.hasImage) { html += ' + design image'; }
    html += `</span></div>`;

    if (m.docs.length > 0) {
      m.docs.forEach(d => {
        const isShared = d.app === 'shared';
        html += `<div class="sl-ctx-doc">`;
        html += `<span class="sl-ctx-src">${esc(d.source)}</span>`;
        html += `<span class="sl-ctx-arrow">&#8594;</span>`;
        html += `<span class="sl-ctx-kb">${esc(d.file)}</span>`;
        if (isShared) { html += `<span class="sl-ctx-tag">shared</span>`; }
        html += `</div>`;
      });
    }
    html += `<div class="sl-ctx-divider"></div>`;

    const ctxSection = document.getElementById('sl-ctx-section');
    if (ctxSection) { ctxSection.innerHTML = html; }

    // Replace the "Retrieving context..." placeholder with the file scanning placeholder
    const placeholder = document.getElementById('sl-files-placeholder');
    if (placeholder) { placeholder.innerHTML = '<span class="sl-dot"></span>Generating files\u2026'; }

    $streamChars.textContent = `${m.totalDocs} doc${m.totalDocs !== 1 ? 's' : ''}`;
  }

  function appendStream(chunk: string) {
    streamBuffer += chunk;
    streamCharCount += chunk.length;

    // Detect framework from delimiter format: "FRAMEWORK: react"
    if (!streamFramework) {
      const fw = streamBuffer.match(/^FRAMEWORK:\s*([a-zA-Z0-9_.+-]+)/m);
      if (fw) { streamFramework = fw[1]; }
    }

    // Detect file paths from delimiter format: "=== FILE: src/App.tsx ==="
    const pathRe = /={3,}\s*FILE:\s*([^\n=]+?)\s*={3,}/g;
    let m: RegExpExecArray | null;
    let changed = false;
    while ((m = pathRe.exec(streamBuffer)) !== null) {
      const p = m[1].trim();
      if (p && !streamFiles.includes(p)) { streamFiles.push(p); changed = true; }
    }

    if (!changed && !streamFramework) { return; } // nothing readable yet — keep scanning placeholder

    // Render clean file list
    let html = '';
    if (streamFramework) {
      html += `<div class="sl-fw">&#9656;&nbsp;Framework: <strong>${esc(streamFramework)}</strong></div>`;
    }
    streamFiles.forEach((f, i) => {
      const isActive = i === streamFiles.length - 1;
      const cls = isActive ? 'sl-file active' : 'sl-file done';
      const ic  = isActive ? '&#9679;' : '&#10003;'; // ● or ✓
      html += `<div class="${cls}"><span class="sl-ic">${ic}</span>${esc(f)}</div>`;
    });

    // Preserve the context section (injected by kbContext), only replace the files area
    const ctxSection = document.getElementById('sl-ctx-section');
    const ctxHtml = ctxSection ? ctxSection.outerHTML : '';
    $streamBody.innerHTML = ctxHtml + html;
    $streamBody.scrollTop = $streamBody.scrollHeight;
    $streamChars.textContent = streamFiles.length
      ? streamFiles.length + ' file' + (streamFiles.length !== 1 ? 's' : '') + ' detected'
      : Math.round(streamCharCount / 1024) + ' KB';
  }

  function closeStream(ok: boolean) {
    $streamPulse.className = 'stream-pulse ' + (ok ? 'done' : '');
    $streamLabel.textContent = ok ? 'Generation complete' : 'Generation failed';
    // Only patch active→done if the generated handler hasn't already rewritten the body
    const active = $streamBody.querySelector('.sl-file.active');
    if (active) {
      active.classList.replace('active', 'done');
      const ic = active.querySelector('.sl-ic');
      if (ic) { ic.innerHTML = '&#10003;'; }
    }
  }

  function renderChips(container: Element, counter: Element, files: string[]) {
    counter.textContent = `(${files.length})`;
    container.innerHTML = files.map(f => `<div class="chip" title="${esc(f)}">${esc(f)}</div>`).join('');
  }

  function setStatus(msg: string, kind: 'info' | 'error' | 'ok' | 'dim') {
    $status.innerHTML = `<span class="s-${kind}">${esc(msg)}</span>`;
  }

  function esc(s: string): string {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }
})();
