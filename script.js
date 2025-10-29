const apiEndpoint = 'https://en.wikipedia.org/w/api.php?format=json&origin=*';
const $ = id => document.getElementById(id);
const logEl = $('log');
const resultEl = $('result');
let stopRequested = false;
let startTime;
let blacklist = new Set();

function log(...args) {
  const line = args.join(' ');
  console.log(line);
  logEl.textContent = (logEl.textContent ? logEl.textContent + '\n' : '') + line;
  logEl.scrollTop = logEl.scrollHeight;
}

function resetUI() {
  logEl.textContent = '';
  resultEl.innerHTML = '';
  $('visitedCount').textContent = '0';
  $('frontSizes').textContent = '0 / 0';
  $('meetNode').textContent = '—';
  $('elapsed').textContent = '0s';
  blacklist.clear();
}

function elapsedSeconds() {
  return Math.floor((Date.now() - startTime)/1000);
}

function updateStats(visited, frontF, frontB, meet) {
  $('visitedCount').textContent = visited;
  $('frontSizes').textContent = `${frontF} / ${frontB}`;
  $('meetNode').textContent = meet || '—';
  $('elapsed').textContent = elapsedSeconds() + 's';
}

// Normalizes input
function extractTitle(input) {
  if (!input) return null;
  input = input.trim();
  try {
    const u = new URL(input);
    if (u.hostname.endsWith('wikipedia.org')) {
      const m = u.pathname.match(/^\/wiki\/(.+)$/);
      if (m) input = decodeURIComponent(m[1]);
    }
  } catch (e) {
    // Not full url
  }
  // input doesn't match
  return input.replace(/_/g, ' ').trim();
}

// Fetch raw wikitext of a page
async function fetchWikitext(title) {
  const url = `${apiEndpoint}&action=parse&page=${encodeURIComponent(title)}&prop=wikitext`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Network error ${resp.status}`);
  const data = await resp.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.parse?.wikitext?.['*'] || '';
}

// Extract all linked page titles from wikitext (format: [[Title]])
function extractWikiLinks(wikitext) {
  const links = [];
  const regex = /\[\[([^\]|#]+)(?:[^\]]*)\]\]/g;
  let m;
  while ((m = regex.exec(wikitext)) !== null) {
    const title = m[1].trim();
    if (title && !title.startsWith('File:') && !title.startsWith('Image:') && !title.startsWith('Category:')) {
      links.push(title.replace(/_/g, ' '));
    }
  }
  return links;
}

// Remove links from templates ({{Navbox ...}} or {{Infobox ...}})
function removeBoxLinks(wikitext, options) {
  let text = wikitext;
  if (!options.includeInfobox) text = text.replace(/\{\{Infobox[\s\S]*?\}\}/gi, '');
  if (!options.includeNavbox) text = text.replace(/\{\{Navbox[\s\S]*?\}\}/gi, '');
  return extractWikiLinks(text);
}

// Fetch all outgoing links from title; returns array of target titles
async function fetchOutgoingLinks(title, maxPerPage = 500, options = {}) {
  // If filtering, use slower wikitext-based extraction instead
  if (!options.includeInfobox || !options.includeNavbox) {
    const wikitext = await fetchWikitext(title);
    return Array.from(new Set(removeBoxLinks(wikitext, options)));
  }

  // else use faster prop=links
  const results = new Set();
  const encodedTitle = encodeURIComponent(title);
  let plcontinue = null;
  do {
    let url = `${apiEndpoint}&action=query&titles=${encodedTitle}&prop=links&plnamespace=0&pllimit=${maxPerPage}`;
    if (plcontinue) url += `&plcontinue=${encodeURIComponent(plcontinue)}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Network error ${resp.status}`);
    const data = await resp.json();
    if (data.error) throw new Error(JSON.stringify(data.error));
    const pages = data.query?.pages;
    if (pages) {
      for (const pid in pages) {
        const p = pages[pid];
        if (p.links) {
          for (const link of p.links) {
            if (link.ns === 0 && link.title) results.add(link.title);
          }
        }
      }
    }
    plcontinue = data.continue?.plcontinue || null;
    await new Promise(r => setTimeout(r, 50));
  } while (plcontinue && !stopRequested);
  return Array.from(results);
}

// Fetch all backlinks from title; returns array of target titles
async function fetchIncomingLinks(title, maxPerPage = 500) {
  const results = new Set();
  const encodedTitle = encodeURIComponent(title);
  let blcontinue = null;
  do {
    let url = `${apiEndpoint}&action=query&list=backlinks&bltitle=${encodedTitle}&blnamespace=0&bllimit=${maxPerPage}`;
    if (blcontinue) url += `&blcontinue=${encodeURIComponent(blcontinue)}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Network error ${resp.status}`);
    const data = await resp.json();
    if (data.error) throw new Error(JSON.stringify(data.error));
    if (data.query?.backlinks) {
      for (const bl of data.query.backlinks) {
        if (bl.title) results.add(bl.title);
      }
    }
    blcontinue = data.continue?.blcontinue || null;
    await new Promise(r => setTimeout(r, 50));
  } while (blcontinue && !stopRequested);
  return Array.from(results);
}

// Get the canonical title of a Wikipedia page (capitalization)
async function getCanonicalTitle(title) {
  const url = `${apiEndpoint}&action=query&titles=${encodeURIComponent(title)}&redirects=1`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Network error ${resp.status}`);
  const data = await resp.json();

  if (data.query && data.query.pages) {
    const pages = Object.values(data.query.pages);
    const first = pages[0];
    if (first.missing) return null;
    // The API returns the normalized / redirected title in .title
    return first.title;
  }
  return null;
}

// Check if a page exists on Wikipedia
async function pageExists(title) {
  const canonical = await getCanonicalTitle(title);
  return canonical;
}

// Bidirectional BFS main funct
// - startTitle: source
// - targetTitle: destination
// - options: maxDepth, maxNodes, blacklist
async function bidirectionalSearch(startTitle, targetTitle, options={}) {
  stopRequested = false;
  const maxDepth = options.maxDepth || 6;
  const maxNodes = options.maxNodes || 2000;
  const blacklist = options.blacklist || new Set();

  if (startTitle.toLowerCase() === targetTitle.toLowerCase()) return { path: [startTitle], length: 0, meet: startTitle };

  const qF = [], qB = [];
  const depthF = new Map(), depthB = new Map();
  const prevF = new Map(), prevB = new Map();
  const visitedF = new Set(), visitedB = new Set();

  qF.push(startTitle); depthF.set(startTitle,0); visitedF.add(startTitle);
  qB.push(targetTitle); depthB.set(targetTitle,0); visitedB.add(targetTitle);

  let nodesExplored = 0;
  let meetNode = null;

  function anyIntersection() {
    for (const t of visitedF) if (visitedB.has(t)) return t;
    return null;
  }

  startTime = Date.now();
  log(`Starting bidirectional search: "${startTitle}" → "${targetTitle}"`);
  updateStats(0, qF.length, qB.length, null);

  while ((qF.length || qB.length) && !stopRequested) {
    const expandForward = qF.length <= qB.length;

    if (expandForward) {
      const current = qF.shift();
      const curDepth = depthF.get(current) || 0;
      if (curDepth < maxDepth) {
        log(`[F] Expanding "${current}" (depth ${curDepth})`);
        let neighbors = [];
        try {
          neighbors = await fetchOutgoingLinks(current, 500, {
            includeInfobox: $('includeInfobox').checked,
            includeNavbox: $('includeNavbox').checked
          });
        } catch { neighbors = []; }
        nodesExplored += 1;
        for (const nb of neighbors) {
          if (stopRequested) break;
          if (!visitedF.has(nb) && !blacklist.has(`${current}→${nb}`)) {
            visitedF.add(nb);
            prevF.set(nb, current);
            depthF.set(nb, curDepth+1);
            qF.push(nb);
            if (visitedB.has(nb)) { meetNode = nb; log(`[+] Meeting node found: "${nb}"`); break; }
          }
        }
      }
    } else {
      const current = qB.shift();
      const curDepth = depthB.get(current) || 0;
      if (curDepth < maxDepth) {
        log(`[B] Expanding incoming links to "${current}" (depth ${curDepth})`);
        let neighbors = [];
        try { neighbors = await fetchIncomingLinks(current); } catch { neighbors = []; }
        nodesExplored += 1;
        for (const nb of neighbors) {
          if (stopRequested) break;
          if (!visitedB.has(nb) && !blacklist.has(`${nb}→${current}`)) {
            visitedB.add(nb);
            prevB.set(nb, current);
            depthB.set(nb, curDepth+1);
            qB.push(nb);
            if (visitedF.has(nb)) { meetNode = nb; log(`[+] Meeting node found: "${nb}"`); break; }
          }
        }
      }
    }

    updateStats(visitedF.size + visitedB.size, qF.length, qB.length, meetNode);
    if (meetNode) break;
    if (nodesExplored >= maxNodes) { log(`[!] Reached max nodes limit (${nodesExplored}). Stopping.`); break; }
  }

  if (!meetNode) {
    const inter = anyIntersection();
    if (inter) { meetNode = inter; log(`[+] Meeting node (via intersection check): "${meetNode}"`); }
  }

  if (!meetNode) return { path: null, length: null, meet: null, visited: visitedF.size + visitedB.size };

  // Reconstruct path
  const pathF = []; let cur = meetNode;
  while (cur !== undefined) { pathF.push(cur); const p = prevF.get(cur); if (!p) break; cur = p; }
  pathF.reverse();
  const pathB = []; cur = meetNode;
  while (true) { const next = prevB.get(cur); if (!next) break; pathB.push(next); cur = next; if (cur === targetTitle) break; }
  const fullPath = pathF.concat(pathB);
  const length = fullPath.length - 1;

  return { path: fullPath, length, meet: meetNode, visited: visitedF.size + visitedB.size };
}

// Verifies that the half of a chain after the meeting node actually connects going forward (may need work)
async function verifyChain(chain) {
  for (let i = 0; i < chain.length - 1; i++) {
    const from = chain[i];
    const to = chain[i + 1];

    try {
      const [canonicalFrom, canonicalTo] = await Promise.all([
        getCanonicalTitle(from),
        getCanonicalTitle(to)
      ]);

      if (!canonicalFrom || !canonicalTo) {
        log(`[!] Missing canonical title for "${from}" or "${to}"`);
        return { valid: false, index: i, from, to };
      }

      const neighbors = await fetchOutgoingLinks(canonicalFrom, 500, {
        includeInfobox: true,
        includeNavbox: true
      });

      const normalizedTo = canonicalTo.toLowerCase();
      const found = neighbors.some(nb => nb.toLowerCase() === normalizedTo);

      if (!found) {
        log(`[!] Could not confirm link "${canonicalFrom}" → "${canonicalTo}"`);
        return { valid: false, index: i, from: canonicalFrom, to: canonicalTo };
      }
    } catch (err) {
      log(`[!] Error verifying link "${from}" → "${to}": ${err}`);
      return { valid: false, index: i, from, to };
    }
  }

  return { valid: true };
}

// UI
$('startBtn').addEventListener('click', async () => {
  resetUI();
  stopRequested = false;
  $('startBtn').disabled = true;
  $('stopBtn').disabled = false;

  const rawSource = $('source').value;
  const rawTarget = $('target').value;
  const maxDepth = Number($('maxDepth').value) || 6;
  const maxNodes = Number($('maxNodes').value) || 2000;

  const start = extractTitle(rawSource);
  const target = extractTitle(rawTarget);
  if (!start || !target) {
    alert('Please enter both source and destination (URL or title).');
    $('startBtn').disabled = false;
    $('stopBtn').disabled = true;
    return;
  }

  // Make sure pages exist
  log(`[i] Checking if pages exist...`);
  const [canonicalStart, canonicalTarget] = await Promise.all([
    pageExists(start),
    pageExists(target)
  ]);

  if (!canonicalStart || !canonicalTarget) {
    let msg = 'Error:\n';
    if (!canonicalStart) msg += `• "${start}" does not exist on Wikipedia.\n`;
    if (!canonicalTarget) msg += `• "${target}" does not exist on Wikipedia.\n`;
    alert(msg);
    $('startBtn').disabled = false;
    $('stopBtn').disabled = true;
    return;
  }

  log(`[i] Using canonical titles:\n  Source → "${canonicalStart}"\n  Target → "${canonicalTarget}"`);
  const startCanonical = canonicalStart;
  const targetCanonical = canonicalTarget;
  startTime = Date.now();

  try {
    let res = await bidirectionalSearch(startCanonical, targetCanonical, { maxDepth, maxNodes, blacklist });

    while (res.path) {
      const verification = await verifyChain(res.path);

      if (verification.valid) break;

      log(`[!] Faulty connection detected: "${verification.from}" → "${verification.to}"`);
      blacklist.add(`${verification.from}→${verification.to}`);
      log(`[i] Retrying search excluding faulty edge...`);
      res = await bidirectionalSearch(start, target, { maxDepth, maxNodes, blacklist });
    }

    if (res.path) {
      log(`\n=== Chain found (length ${res.length}) ===`);
      resultEl.innerHTML = `<strong>Chain (length ${res.length}):</strong><br>` +
        res.path.map((t,i)=>{ const href=`https://en.wikipedia.org/wiki/${encodeURIComponent(t.replace(/ /g,'_'))}`; return `<a href="${href}" target="_blank" rel="noopener noreferrer">${t}</a>`+(i<res.path.length-1?' → ':''); }).join(' ');
      log(`Chain: ${res.path.join(' -> ')}`);
      log(`Nodes visited (approx): ${res.visited || 'unknown'}`);
      $('meetNode').textContent = res.meet || '—';
    } else {
      log(`\nNo chain found within the given limits.`);
      resultEl.innerHTML = `<strong>No chain found</strong>. Try increasing max depth or max nodes.`;
    }
  } catch (err) {
    log(`Error during search: ${err}`);
    resultEl.innerHTML = `<strong>Error:</strong> ${err}`;
  } finally {
    $('startBtn').disabled = false;
    $('stopBtn').disabled = true;
    updateStats('-', '-', '-', $('meetNode').textContent);
  }
});

// Enter to start
['source', 'target'].forEach(id => {
  $(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!$('startBtn').disabled) {
        $('startBtn').click();
      }
    }
  });
});

function saveCheckboxPrefs() {
  localStorage.setItem('includeInfobox', $('includeInfobox').checked ? '1' : '0');
  localStorage.setItem('includeNavbox', $('includeNavbox').checked ? '1' : '0');
}

function restoreCheckboxPrefs() {
  const infoboxPref = localStorage.getItem('includeInfobox');
  const navboxPref = localStorage.getItem('includeNavbox');
  if (infoboxPref !== null) $('includeInfobox').checked = infoboxPref === '1';
  if (navboxPref !== null) $('includeNavbox').checked = navboxPref === '1';
}

// Restore checkbox preferences when page loads
document.addEventListener('DOMContentLoaded', restoreCheckboxPrefs);

// Save checkbox preferences when user toggles
['includeInfobox', 'includeNavbox'].forEach(id => {
  $(id).addEventListener('change', saveCheckboxPrefs);
});

// Stop button
$('stopBtn').addEventListener('click', () => {
  stopRequested = true;
  log('[!] Stop requested by user.');
  $('stopBtn').disabled = true;
  $('startBtn').disabled = false;
});

// About banner toggle
document.addEventListener("DOMContentLoaded", () => {
  const banner = $('aboutBanner');
  const toggle = $('aboutToggle');
  
  toggle.addEventListener("click", () => {
    banner.classList.toggle("open");
  });

  document.addEventListener("click", (e) => {
    if (!banner.contains(e.target)) banner.classList.remove("open");
  });
});
