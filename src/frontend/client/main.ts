// Webview client script — runs in the browser context of the VS Code webview
declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

(function () {
  const vscode = acquireVsCodeApi();

  // ── DOM refs — Dev ──────────────────────────────────────────
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

  // ── BA state ──────────────────────────────────────────────
  let baLastMarkdownPath = '';
  let baLastExcelBase64 = '';
  let baLastExcelFileName = '';
  let baLastCsvData = '';
  let baLastCsvFileName = '';
  let brdLastMarkdownPath = '';

  // ── QA state ──────────────────────────────────────────────
  let qaLastMarkdownPath = '';
  let qaLastExcelBase64 = '';
  let qaLastExcelFileName = '';
  let qaLastCsvData = '';
  let qaLastCsvFileName = '';
  let qaTestRunning = false;

  // ── Mascot ────────────────────────────────────────────────
  const $mascot = document.getElementById('mascot')!;
  const $mascotMood = document.getElementById('mascot-mood')!;
  type MascotState = 'idle' | 'thinking' | 'celebrating' | 'sad';
  const idleMoods: Record<string, string> = {
    dev: 'Ready to code', kb: 'Browsing your docs',
    ba: 'Planning ahead', qa: 'On standby',
  };
  const transientMoods: Record<Exclude<MascotState, 'idle'>, string> = {
    thinking: 'Thinking hard\u2026', celebrating: 'Looks amazing!', sad: 'Oops, try again',
  };
  let currentModule = 'dev';
  let mascotTimer: ReturnType<typeof setTimeout> | undefined;

  function setMascot(state: MascotState, autoRevertMs?: number) {
    if (mascotTimer) { clearTimeout(mascotTimer); mascotTimer = undefined; }
    $mascot.className = 'mascot ' + state + ' mod-' + currentModule;
    $mascotMood.textContent = state === 'idle' ? (idleMoods[currentModule] || 'Ready') : transientMoods[state];
    if (autoRevertMs && state !== 'idle') {
      mascotTimer = setTimeout(() => setMascot('idle'), autoRevertMs);
    }
  }

  // ── Module switching ──────────────────────────────────────
  const $views: Record<string, HTMLElement> = {
    dev: document.getElementById('view-dev')!,
    kb: document.getElementById('view-kb')!,
    ba: document.getElementById('view-ba')!,
    qa: document.getElementById('view-qa')!,
  };
  const $moduleCards = Array.from(document.querySelectorAll<HTMLButtonElement>('.module-card'));

  function setModule(id: string) {
    if (!$views[id]) { return; }
    for (const [k, el] of Object.entries($views)) { el.hidden = k !== id; }
    $moduleCards.forEach(c => c.classList.toggle('active', c.dataset.module === id));
    currentModule = id;
    if ($mascot.classList.contains('idle')) { setMascot('idle'); }
    else { $mascot.className = $mascot.className.replace(/\bmod-\w+/g, '') + ' mod-' + id; }
    saveState({ module: id });
  }
  $moduleCards.forEach(c => c.addEventListener('click', () => setModule(c.dataset.module || 'dev')));

  // ── Sub-tabs: BA ──────────────────────────────────────────
  const baTabs: Record<string, HTMLElement> = {
    stories: document.getElementById('ba-tab-stories')!,
    brd: document.getElementById('ba-tab-brd')!,
    bafiles: document.getElementById('ba-tab-bafiles')!,
  };
  document.querySelectorAll<HTMLButtonElement>('[data-ba-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.baTab!;
      for (const [k, el] of Object.entries(baTabs)) { el.hidden = k !== id; }
      document.querySelectorAll('[data-ba-tab]').forEach(b => b.classList.toggle('active', (b as HTMLElement).dataset.baTab === id));
    });
  });

  // ── Sub-tabs: QA ──────────────────────────────────────────
  const qaTabs: Record<string, HTMLElement> = {
    testcases: document.getElementById('qa-tab-testcases')!,
    scripts: document.getElementById('qa-tab-scripts')!,
    run: document.getElementById('qa-tab-run')!,
    qafiles: document.getElementById('qa-tab-qafiles')!,
  };
  document.querySelectorAll<HTMLButtonElement>('[data-qa-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.qaTab!;
      for (const [k, el] of Object.entries(qaTabs)) { el.hidden = k !== id; }
      document.querySelectorAll('[data-qa-tab]').forEach(b => b.classList.toggle('active', (b as HTMLElement).dataset.qaTab === id));
    });
  });

  // ── Theme toggle ──────────────────────────────────────────
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

  // ── Dev event listeners ───────────────────────────────────
  $modelPicker.addEventListener('change', () =>
    vscode.postMessage({ type: 'selectModel', modelId: $modelPicker.value }));

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
    attachedBase64 = undefined; attachedMime = undefined;
    $imgPreview.style.display = 'none'; $imgPreview.src = '';
    $imgHint.style.display = ''; $imgName.style.display = 'none';
    $imgName.textContent = ''; $btnRemoveImg.style.display = 'none';
    $imgZone.classList.remove('has-img');
  });

  document.getElementById('btn-generate')!.addEventListener('click', () => {
    const prompt = $prompt.value.trim();
    if (!prompt) { setStatus('Enter a prompt first.', 'error'); return; }
    resetStream(); setStatus('Generating project...', 'info');
    vscode.postMessage({ type: 'generate', prompt, imageBase64: attachedBase64, imageMime: attachedMime });
  });

  document.getElementById('btn-refresh')!.addEventListener('click', () =>
    vscode.postMessage({ type: 'refresh' }));

  // ── BA event listeners ────────────────────────────────────
  const $baDrop = document.getElementById('ba-drop-zone')!;
  const $baDocsList = document.getElementById('ba-docs-list')!;
  const $baDocsCount = document.getElementById('ba-docs-count')!;

  document.getElementById('btn-ba-add-docs')!.addEventListener('click', () =>
    vscode.postMessage({ type: 'ba:addDocs' }));

  $baDrop.addEventListener('click', () =>
    vscode.postMessage({ type: 'ba:addDocs' }));

  $baDrop.addEventListener('dragover', e => { e.preventDefault(); $baDrop.classList.add('drag-over'); });
  $baDrop.addEventListener('dragleave', () => $baDrop.classList.remove('drag-over'));
  $baDrop.addEventListener('drop', e => {
    e.preventDefault(); $baDrop.classList.remove('drag-over');
    // Files dropped from VS Code explorer — trigger the add dialog as fallback
    vscode.postMessage({ type: 'ba:addDocs' });
  });

  document.getElementById('btn-ba-gen-stories')!.addEventListener('click', () => {
    setStatus('Generating user stories...', 'info');
    setMascot('thinking');
    vscode.postMessage({ type: 'ba:generateStories' });
  });

  document.getElementById('btn-ba-dl-excel')!.addEventListener('click', () => {
    if (baLastExcelBase64) { downloadBase64(baLastExcelBase64, baLastExcelFileName, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); }
  });

  document.getElementById('btn-ba-dl-csv')!.addEventListener('click', () => {
    if (baLastCsvData) { downloadText(baLastCsvData, baLastCsvFileName, 'text/csv'); }
  });

  document.getElementById('btn-ba-open-md')!.addEventListener('click', () => {
    if (baLastMarkdownPath) { vscode.postMessage({ type: 'ba:openOutput', filePath: baLastMarkdownPath }); }
  });

  document.getElementById('btn-ba-brd-from-stories')!.addEventListener('click', () => {
    setStatus('Generating BRD from stories...', 'info');
    setMascot('thinking');
    vscode.postMessage({ type: 'ba:generateBrd', sourceType: 'stories' });
  });

  document.getElementById('btn-ba-brd-from-docs')!.addEventListener('click', () => {
    setStatus('Generating BRD from documents...', 'info');
    setMascot('thinking');
    vscode.postMessage({ type: 'ba:generateBrd', sourceType: 'docs' });
  });

  document.getElementById('btn-ba-open-brd')!.addEventListener('click', () => {
    if (brdLastMarkdownPath) { vscode.postMessage({ type: 'ba:openOutput', filePath: brdLastMarkdownPath }); }
  });

  // ── QA event listeners ────────────────────────────────────
  document.getElementById('btn-qa-gen-tc')!.addEventListener('click', () => {
    setStatus('Generating test cases...', 'info');
    setMascot('thinking');
    vscode.postMessage({ type: 'qa:generateTestCases', sourceType: 'stories' });
  });

  document.getElementById('btn-qa-dl-excel')!.addEventListener('click', () => {
    if (qaLastExcelBase64) { downloadBase64(qaLastExcelBase64, qaLastExcelFileName, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); }
  });

  document.getElementById('btn-qa-dl-csv')!.addEventListener('click', () => {
    if (qaLastCsvData) { downloadText(qaLastCsvData, qaLastCsvFileName, 'text/csv'); }
  });

  document.getElementById('btn-qa-open-md')!.addEventListener('click', () => {
    if (qaLastMarkdownPath) { vscode.postMessage({ type: 'qa:openOutput', filePath: qaLastMarkdownPath }); }
  });

  document.getElementById('btn-qa-gen-scripts')!.addEventListener('click', () => {
    const url = (document.getElementById('qa-base-url') as HTMLInputElement).value.trim() || 'http://localhost:3000';
    setStatus('Generating Playwright scripts...', 'info');
    setMascot('thinking');
    vscode.postMessage({ type: 'qa:generateScripts', baseUrl: url, sourceType: 'testcases' });
  });

  const $btnRun = document.getElementById('btn-qa-run')!;
  const $btnStop = document.getElementById('btn-qa-stop')!;

  $btnRun.addEventListener('click', () => {
    setStatus('Running Playwright tests...', 'info');
    setMascot('thinking');
    vscode.postMessage({ type: 'qa:runTests' });
  });

  $btnStop.addEventListener('click', () => {
    vscode.postMessage({ type: 'qa:stopTests' });
    $btnStop.style.display = 'none';
    $btnRun.style.display = '';
  });

  // ── Message handler ───────────────────────────────────────

  window.addEventListener('message', (e: MessageEvent) => {
    const msg = e.data as { type: string } & Record<string, unknown>;

    switch (msg.type) {
      // ── Models ──
      case 'models': {
        const models = msg.models as { id: string; name: string }[];
        const selectedId = msg.selectedId as string | undefined;
        $modelPicker.innerHTML = models.length
          ? models.map(m => `<option value="${esc(m.id)}"${m.id === selectedId ? ' selected' : ''}>${esc(m.name)}</option>`).join('')
          : '<option value="">No Copilot models found</option>';
        break;
      }

      // ── Tree (file lists) ──
      case 'tree': {
        type Item = { name: string; kind: string };
        renderList($kbList, $kbCount, msg.kb as Item[], true);
        renderList($inboxList, $inboxCount, msg.inbox as Item[], false);
        renderList($rawList, $rawCount, msg.rawSources as Item[], false);
        const gen = msg.generated as Item[];
        if (gen?.length) { renderChips($genList, $genCount, gen.map(f => f.name)); $genFiles.style.display = ''; }
        // BA output files
        const baOut = msg.baOutput as Item[];
        renderList(document.getElementById('ba-output-list')!, document.getElementById('ba-output-count')!, baOut ?? [], false);
        // QA output files
        const qaOut = msg.qaOutput as Item[];
        renderList(document.getElementById('qa-output-list')!, document.getElementById('qa-output-count')!, qaOut ?? [], false);
        break;
      }

      // ── Image ──
      case 'imageAttached': {
        attachedBase64 = msg.base64 as string; attachedMime = msg.mime as string;
        $imgPreview.src = `data:${msg.mime};base64,${msg.base64}`;
        $imgPreview.style.display = 'block'; $imgHint.style.display = 'none';
        $imgName.textContent = msg.name as string; $imgName.style.display = '';
        $btnRemoveImg.style.display = ''; $imgZone.classList.add('has-img');
        break;
      }

      // ── Dev stream ──
      case 'streamStart': resetStream(); openStream(); setMascot('thinking'); break;
      case 'kbContext': renderKbContext(msg); break;
      case 'stream': appendStream(msg.chunk as string); break;
      case 'progress': setStatus(msg.message as string, 'info'); break;
      case 'status': setStatus(msg.message as string, 'ok'); break;
      case 'error': setStatus(msg.message as string, 'error'); closeStream(false); setMascot('sad', 4500); break;
      case 'errors': setStatus((msg.errors as string[]).join(' | '), 'error'); closeStream(false); setMascot('sad', 4500); break;

      case 'generated': {
        const genFiles = msg.files as string[];
        const fw = (msg.framework as string) || streamFramework || 'unknown';
        renderChips($genList, $genCount, genFiles);
        $genFiles.style.display = '';
        const finalFw = fw !== 'unknown' ? fw : streamFramework;
        let html = '';
        if (finalFw) { html += `<div class="sl-fw">&#9656;&nbsp;Framework: <strong>${esc(finalFw)}</strong></div>`; }
        genFiles.forEach(f => { html += `<div class="sl-file done"><span class="sl-ic">&#10003;</span>${esc(f)}</div>`; });
        const extGroups: Record<string, number> = {};
        genFiles.forEach(f => { const ext = f.includes('.') ? f.split('.').pop()! : 'other'; extGroups[ext] = (extGroups[ext] || 0) + 1; });
        const groupSummary = Object.entries(extGroups).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([e, c]) => `${c} .${e}`).join(', ');
        html += `<div class="sl-summary">&#10022;&nbsp;${genFiles.length} files &mdash; ${groupSummary}${groupSummary ? ' &mdash; ' : ''}run <code>npm install</code> then start the dev server.</div>`;
        const ctxSection = document.getElementById('sl-ctx-section');
        const ctxHtml = ctxSection ? ctxSection.outerHTML : '';
        $streamBody.innerHTML = ctxHtml + html;
        $streamBody.scrollTop = 0; $streamChars.textContent = genFiles.length + ' files';
        closeStream(true); setStatus(`Generated ${msg.fileCount} files (${fw}) — check Generated Files below`, 'ok');
        setMascot('celebrating', 4500);
        break;
      }

      // ── BA messages ──
      case 'ba:docsAdded': {
        const files = msg.files as string[];
        $baDocsCount.textContent = `(${files.length})`;
        $baDocsList.innerHTML = files.map(f => `<li><span class="file-ico">&bull;</span><span class="file-name">${esc(f)}</span></li>`).join('');
        break;
      }

      case 'ba:streamStart': {
        const $bp = document.getElementById('ba-stream-panel')!;
        const $bb = document.getElementById('ba-stream-body')!;
        const $bl = document.getElementById('ba-stream-label')!;
        $bp.style.display = ''; $bb.innerHTML = '<div class="sl-scanning"><span class="sl-dot"></span>Thinking\u2026</div>';
        $bl.textContent = (msg.label as string) || 'Generating\u2026';
        document.getElementById('ba-stream-pulse')!.className = 'stream-pulse active';
        document.getElementById('ba-stories-result')!.style.display = 'none';
        break;
      }
      case 'ba:stream': {
        const $bb = document.getElementById('ba-stream-body')!;
        // Just show a "working" indicator, not raw LLM output
        const $chars = document.getElementById('ba-stream-chars')!;
        $chars.textContent = Math.round(((($chars.textContent?.replace(' chars', '') || '0') as unknown as number) || 0) + (msg.chunk as string).length / 1024 * 1024) + ' chars';
        break;
      }

      case 'ba:storiesDone': {
        document.getElementById('ba-stream-panel')!.style.display = 'none';
        document.getElementById('ba-stream-pulse')!.className = 'stream-pulse done';
        const stories = msg.stories as Array<{id:string;epic:string;title:string;story:string;priority:string;points:number}>;
        baLastMarkdownPath = msg.markdownPath as string;
        baLastExcelBase64 = msg.excelBase64 as string;
        baLastExcelFileName = msg.excelFileName as string;
        baLastCsvFileName = msg.csvFileName as string;
        const $result = document.getElementById('ba-stories-result')!;
        const $count = document.getElementById('ba-stories-count')!;
        $count.textContent = `(${stories.length} stories)`;
        const $tbody = document.getElementById('ba-stories-tbody')!;
        $tbody.innerHTML = stories.map(s => `<tr>
          <td><strong>${esc(s.id)}</strong></td>
          <td>${esc(s.epic)}</td>
          <td>${esc(s.title)}</td>
          <td style="white-space:normal;max-width:260px">${esc(s.story.slice(0, 100))}${s.story.length > 100 ? '…' : ''}</td>
          <td><span class="badge badge-${s.priority.toLowerCase()}">${esc(s.priority)}</span></td>
          <td>${s.points}</td>
        </tr>`).join('');
        $result.style.display = '';
        setMascot('celebrating', 4500);
        break;
      }

      case 'ba:brdStreamStart': {
        const $bp = document.getElementById('brd-stream-panel')!;
        const $bb = document.getElementById('brd-stream-body')!;
        $bp.style.display = ''; $bb.innerHTML = '<div class="sl-scanning"><span class="sl-dot"></span>Thinking\u2026</div>';
        document.getElementById('brd-stream-label')!.textContent = (msg.label as string) || 'Generating BRD\u2026';
        document.getElementById('brd-stream-pulse')!.className = 'stream-pulse active';
        document.getElementById('ba-brd-result')!.style.display = 'none';
        break;
      }
      case 'ba:brdStream': break; // progress handled via status bar

      case 'ba:brdDone': {
        const $bp = document.getElementById('brd-stream-panel')!;
        $bp.style.display = 'none';
        document.getElementById('brd-stream-pulse')!.className = 'stream-pulse done';
        brdLastMarkdownPath = msg.markdownPath as string;
        document.getElementById('ba-brd-result')!.style.display = '';
        document.getElementById('brd-req-count')!.textContent = `(${msg.requirementCount} requirements)`;
        const pre = document.getElementById('brd-preview-text') as HTMLPreElement;
        pre.textContent = (msg.preview as string) + '\u2026';
        setMascot('celebrating', 4500);
        break;
      }

      // ── QA messages ──
      case 'qa:streamStart': {
        const label = (msg.label as string) || 'Generating\u2026';
        // Determine which panel to show based on label content
        if (label.toLowerCase().includes('test case')) {
          showQaStream('qa-tc-stream-panel', 'qa-tc-pulse', 'qa-tc-label', label);
          document.getElementById('qa-tc-result')!.style.display = 'none';
        } else {
          showQaStream('qa-sc-stream-panel', 'qa-sc-pulse', 'qa-sc-label', label);
          document.getElementById('qa-scripts-result')!.style.display = 'none';
        }
        break;
      }
      case 'qa:stream': break; // just let progress messages handle UI feedback

      case 'qa:testCasesDone': {
        document.getElementById('qa-tc-stream-panel')!.style.display = 'none';
        const tcs = msg.testCases as Array<{id:string;suite:string;title:string;type:string;priority:string;steps:string[]}>;
        qaLastMarkdownPath = msg.markdownPath as string;
        qaLastExcelBase64 = msg.excelBase64 as string;
        qaLastExcelFileName = msg.excelFileName as string;
        qaLastCsvFileName = msg.csvFileName as string;
        document.getElementById('qa-tc-count')!.textContent = `(${tcs.length})`;
        const $tbody = document.getElementById('qa-tc-tbody')!;
        $tbody.innerHTML = tcs.map(tc => `<tr>
          <td><strong>${esc(tc.id)}</strong></td>
          <td>${esc(tc.suite)}</td>
          <td>${esc(tc.title)}</td>
          <td>${esc(tc.type)}</td>
          <td><span class="badge badge-${tc.priority.toLowerCase()}">${esc(tc.priority)}</span></td>
          <td>${tc.steps.length} steps</td>
        </tr>`).join('');
        document.getElementById('qa-tc-result')!.style.display = '';
        setMascot('celebrating', 4500);
        break;
      }

      case 'qa:scriptsDone': {
        document.getElementById('qa-sc-stream-panel')!.style.display = 'none';
        const files = msg.files as string[];
        const $list = document.getElementById('qa-scripts-list')!;
        const $count = document.getElementById('qa-scripts-count')!;
        $count.textContent = `(${files.length} files)`;
        $list.innerHTML = files.map(f => `<li><span class="file-ico">&bull;</span><span class="file-name">${esc(f)}</span></li>`).join('');
        document.getElementById('qa-scripts-result')!.style.display = '';
        setMascot('celebrating', 4500);
        break;
      }

      case 'qa:testRunStart': {
        qaTestRunning = true;
        $btnRun.style.display = 'none'; $btnStop.style.display = '';
        document.getElementById('qa-terminal')!.style.display = '';
        document.getElementById('qa-terminal-body')!.textContent = '';
        document.getElementById('qa-terminal-status')!.textContent = 'running';
        document.getElementById('qa-run-result-cards')!.style.display = 'none';
        break;
      }

      case 'qa:testOutput': {
        const $term = document.getElementById('qa-terminal-body')!;
        const line = msg.line as string;
        const kind = msg.kind as string;
        const span = document.createElement('span');
        if (line.includes('passed') || line.includes('✓') || line.startsWith('✅')) {
          span.className = 't-ok';
        } else if (line.includes('failed') || line.includes('✗') || line.startsWith('❌')) {
          span.className = 't-fail';
        } else if (line.includes('warning') || line.includes('⚠')) {
          span.className = 't-warn';
        } else if (kind === 'stderr') {
          span.className = 't-dim';
        }
        span.textContent = line + '\n';
        $term.appendChild(span);
        $term.scrollTop = $term.scrollHeight;
        break;
      }

      case 'qa:testDone': {
        qaTestRunning = false;
        $btnStop.style.display = 'none'; $btnRun.style.display = '';
        document.getElementById('qa-terminal-status')!.textContent = (msg.exitCode as number) === 0 ? 'passed' : 'failed';
        document.getElementById('qa-rc-pass')!.textContent = String(msg.passed ?? 0);
        document.getElementById('qa-rc-fail')!.textContent = String(msg.failed ?? 0);
        document.getElementById('qa-rc-skip')!.textContent = String(msg.skipped ?? 0);
        document.getElementById('qa-rc-dur')!.textContent = `${((msg.durationMs as number ?? 0) / 1000).toFixed(1)}s`;
        document.getElementById('qa-run-result-cards')!.style.display = 'flex';
        setMascot((msg.failed as number) > 0 ? 'sad' : 'celebrating', 4500);
        break;
      }
    }
  });

  // ── Dev stream helpers ────────────────────────────────────

  const $streamPanel = document.getElementById('stream-panel')!;
  const $streamBody = document.getElementById('stream-body')!;
  const $streamLabel = document.getElementById('stream-label')!;
  const $streamChars = document.getElementById('stream-chars')!;
  const $streamPulse = document.getElementById('stream-pulse')!;

  function resetStream() {
    streamBuffer = ''; streamCharCount = 0; streamFramework = ''; streamFiles = [];
    $streamPanel.style.display = 'none'; $streamBody.innerHTML = '';
    $streamChars.textContent = ''; $streamLabel.textContent = 'Copilot is generating\u2026';
    $streamPulse.className = 'stream-pulse';
  }
  function openStream() {
    $streamPanel.style.display = ''; $streamPulse.className = 'stream-pulse active';
    $streamBody.innerHTML = '<div id="sl-ctx-section"></div><div class="sl-scanning" id="sl-files-placeholder"><span class="sl-dot"></span>Retrieving context\u2026</div>';
  }

  type KbContextMsg = { type: string; strategy: 'all'|'tag-prefilter'|'llm-routed'; docs: Array<{file:string;source:string;title:string;app:string}>; totalDocs:number; hasImage:boolean };
  function renderKbContext(msg: Record<string, unknown>) {
    const m = msg as unknown as KbContextMsg;
    const strategyLabel: Record<string, string> = { all: 'full KB', 'tag-prefilter': 'tag match', 'llm-routed': 'LLM routed' };
    const label = strategyLabel[m.strategy] || m.strategy;
    let html = `<div class="sl-ctx-header"><span class="sl-ctx-badge">${esc(label)}</span> <span class="sl-ctx-count">${m.totalDocs} KB doc${m.totalDocs !== 1 ? 's' : ''} retrieved${m.hasImage ? ' + design image' : ''}</span></div>`;
    if (m.docs.length > 0) {
      m.docs.forEach(d => {
        html += `<div class="sl-ctx-doc"><span class="sl-ctx-src">${esc(d.source)}</span><span class="sl-ctx-arrow">&#8594;</span><span class="sl-ctx-kb">${esc(d.file)}</span>${d.app === 'shared' ? '<span class="sl-ctx-tag">shared</span>' : ''}</div>`;
      });
    }
    html += '<div class="sl-ctx-divider"></div>';
    const ctxSection = document.getElementById('sl-ctx-section');
    if (ctxSection) { ctxSection.innerHTML = html; }
    const placeholder = document.getElementById('sl-files-placeholder');
    if (placeholder) { placeholder.innerHTML = '<span class="sl-dot"></span>Generating files\u2026'; }
    $streamChars.textContent = `${m.totalDocs} doc${m.totalDocs !== 1 ? 's' : ''}`;
  }

  function appendStream(chunk: string) {
    streamBuffer += chunk; streamCharCount += chunk.length;
    if (!streamFramework) {
      const fw = streamBuffer.match(/^FRAMEWORK:\s*([a-zA-Z0-9_.+-]+)/m);
      if (fw) { streamFramework = fw[1]; }
    }
    const pathRe = /={3,}\s*FILE:\s*([^\n=]+?)\s*={3,}/g;
    let m: RegExpExecArray | null; let changed = false;
    while ((m = pathRe.exec(streamBuffer)) !== null) {
      const p = m[1].trim();
      if (p && !streamFiles.includes(p)) { streamFiles.push(p); changed = true; }
    }
    if (!changed && !streamFramework) { return; }
    let html = '';
    if (streamFramework) { html += `<div class="sl-fw">&#9656;&nbsp;Framework: <strong>${esc(streamFramework)}</strong></div>`; }
    streamFiles.forEach((f, i) => {
      const isActive = i === streamFiles.length - 1;
      html += `<div class="${isActive ? 'sl-file active' : 'sl-file done'}"><span class="sl-ic">${isActive ? '&#9679;' : '&#10003;'}</span>${esc(f)}</div>`;
    });
    const ctxSection = document.getElementById('sl-ctx-section');
    const ctxHtml = ctxSection ? ctxSection.outerHTML : '';
    $streamBody.innerHTML = ctxHtml + html;
    $streamBody.scrollTop = $streamBody.scrollHeight;
    $streamChars.textContent = streamFiles.length ? streamFiles.length + ' file' + (streamFiles.length !== 1 ? 's' : '') + ' detected' : Math.round(streamCharCount / 1024) + ' KB';
  }

  function closeStream(ok: boolean) {
    $streamPulse.className = 'stream-pulse ' + (ok ? 'done' : '');
    $streamLabel.textContent = ok ? 'Generation complete' : 'Generation failed';
    const active = $streamBody.querySelector('.sl-file.active');
    if (active) { active.classList.replace('active', 'done'); const ic = active.querySelector('.sl-ic'); if (ic) { ic.innerHTML = '&#10003;'; } }
  }

  // ── QA stream helper ──────────────────────────────────────
  function showQaStream(panelId: string, pulseId: string, labelId: string, label: string) {
    const $p = document.getElementById(panelId)!;
    const $b = panelId === 'qa-tc-stream-panel' ? document.getElementById('qa-tc-body')! : document.getElementById('qa-sc-body')!;
    $p.style.display = '';
    document.getElementById(pulseId)!.className = 'stream-pulse active';
    document.getElementById(labelId)!.textContent = label;
    $b.innerHTML = '<div class="sl-scanning"><span class="sl-dot"></span>Working\u2026</div>';
  }

  // ── Generic list renderer ─────────────────────────────────
  type Item = { name: string; kind: string };
  function renderList(container: Element, counter: Element, items: Item[], deletable = false) {
    counter.textContent = items?.length ? `(${items.length})` : '';
    if (!items?.length) { container.innerHTML = '<li class="empty">No files</li>'; return; }
    container.innerHTML = items.map(i => {
      const isDir = i.kind === 'dir';
      const icon = isDir ? '&#9656;' : '&bull;';
      const del = deletable && !isDir
        ? `<button class="file-del" data-name="${esc(i.name)}" title="Delete" type="button">&#10005;</button>` : '';
      return `<li title="${esc(i.name)}"><span class="file-ico">${icon}</span><span class="file-name">${esc(i.name)}</span>${del}</li>`;
    }).join('');
    if (deletable) {
      container.querySelectorAll<HTMLButtonElement>('.file-del').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const name = btn.dataset.name;
          if (name) { vscode.postMessage({ type: 'deleteKbFile', name }); }
        });
      });
    }
  }

  function renderChips(container: Element, counter: Element, files: string[]) {
    counter.textContent = `(${files.length})`;
    container.innerHTML = files.map(f => `<div class="chip" title="${esc(f)}">${esc(f)}</div>`).join('');
  }

  // ── Download helpers ──────────────────────────────────────
  function downloadBase64(b64: string, fileName: string, mimeType: string) {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function downloadText(text: string, fileName: string, mimeType: string) {
    const blob = new Blob([text], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ── Status bar ────────────────────────────────────────────
  function setStatus(msg: string, kind: 'info' | 'error' | 'ok' | 'dim') {
    $status.innerHTML = `<span class="s-${kind}">${esc(msg)}</span>`;
  }

  function esc(s: string): string {
    const d = document.createElement('div'); d.textContent = s; return d.innerHTML;
  }
})();
