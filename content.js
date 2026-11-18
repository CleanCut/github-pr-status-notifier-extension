let githubIcons = [];
let snapshot = { key: null, status: null, at: 0 };
let snapshotPromise = null;

function pullParts() {
  const match = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match || location.hostname !== "github.com") return null;
  return {
    owner: match[1],
    repo: match[2],
    number: match[3],
    key: `${match[1]}/${match[2]}#${match[3]}`,
  };
}

function mapStatus(status) {
  if (status === "pullMerged") return "merged";
  if (status === "pullClosed") return "closed";
  if (status === "draft") return "draft";
  if (status === "pullOpened") return "open";
  return null;
}

function headerState(root) {
  const labels = [...root.querySelectorAll('[data-component="StateLabel"][data-status]')];
  if (labels.length > 0) {
    const status = labels[0].getAttribute("data-status");
    if (labels.every((label) => label.getAttribute("data-status") === status)) {
      return mapStatus(status);
    }
  }

  // The page shows a merged badge for every pull request it mentions.
  // Only the one in the header belongs to this pull request.
  const classic = root.querySelector(
    "#partial-discussion-header .State:not(.State--small), #pull-state .State:not(.State--small)"
  );
  if (!classic) return null;
  if (classic.classList.contains("State--merged")) return "merged";
  if (classic.classList.contains("State--closed")) return "closed";
  if (classic.classList.contains("State--draft")) return "draft";
  if (classic.classList.contains("State--open")) return "open";
  return null;
}

function reviewSignal(root) {
  let approved = false;
  let changes = false;
  for (const icon of root.querySelectorAll(".reviewers-status-icon svg")) {
    if (icon.classList.contains("octicon-file-diff")) changes = true;
    else if (icon.classList.contains("octicon-check")) approved = true;
  }
  for (const tip of root.querySelectorAll('tool-tip[for^="review-status-"]')) {
    const text = tip.textContent.trim();
    if (text.endsWith("requested changes")) changes = true;
    else if (text.endsWith("approved these changes")) approved = true;
  }
  if (changes) return "changes";
  if (approved) return "approved";
  return "none";
}

function sidebarPresent() {
  return document.querySelector("#partial-discussion-sidebar, #pr-conversation-sidebar") !== null;
}

function displayedStatus() {
  if (!pullParts()) return null;
  const state = headerState(document);
  if (state === "merged") return "merged";
  if (state === "closed") return null;
  if (sidebarPresent()) return reviewSignal(document) === "approved" ? "approved" : null;
  if ((state === "open" || state === "draft") && snapshot.key === pullParts().key) {
    return snapshot.status;
  }
  return null;
}

function refreshSnapshot() {
  const parts = pullParts();
  if (!parts || sidebarPresent()) return;
  const state = headerState(document);
  if (state === "merged" || state === "closed") return;
  if (snapshot.key === parts.key && Date.now() - snapshot.at < 30000) return;
  if (snapshotPromise) return;

  const url = new URL(
    `https://github.com/${parts.owner}/${parts.repo}/issues/${parts.number}/show_partial`
  );
  url.searchParams.set("partial", "pull_requests/sidebar/show/reviewers");
  const key = parts.key;
  snapshotPromise = fetch(url, { credentials: "include" })
    .then((res) => (res.ok ? res.text() : null))
    .then((html) => {
      if (pullParts()?.key !== key) return;
      if (!html) {
        snapshot = { key, status: snapshot.key === key ? snapshot.status : null, at: Date.now() };
        return;
      }
      const doc = new DOMParser().parseFromString(html, "text/html");
      snapshot = { key, status: reviewSignal(doc) === "approved" ? "approved" : null, at: Date.now() };
      sync();
    })
    .catch(() => {
      if (pullParts()?.key !== key) return;
      snapshot = { key, status: snapshot.key === key ? snapshot.status : null, at: Date.now() };
    })
    .finally(() => {
      snapshotPromise = null;
    });
}

function iconLinks() {
  return [
    ...document.querySelectorAll(
      'link[rel="icon"], link[rel="alternate icon"], link[rel="shortcut icon"]'
    ),
  ];
}

function isExtensionIcon(href) {
  return href.startsWith(chrome.runtime.getURL(""));
}

function rememberGitHubIcons() {
  const found = iconLinks().filter((link) => !isExtensionIcon(link.href));
  if (found.length === 0) return;
  githubIcons = found.map((link) => link.cloneNode(true));
}

function showExtensionIcon(href) {
  rememberGitHubIcons();
  const links = iconLinks();
  if (links.length === 1 && links[0].rel === "icon" && links[0].href === href) return;
  // Leave either icon link in place and the tab can keep showing GitHub's.
  links.forEach((link) => link.remove());
  const link = document.createElement("link");
  link.rel = "icon";
  link.type = "image/png";
  link.href = href;
  document.head.appendChild(link);
}

function showGitHubIcon() {
  const links = iconLinks();
  // GitHub rewrites its icon links for CI status and dark mode, so leave them alone unless the
  // extension's icon is showing.
  if (githubIcons.length === 0 || !links.some((link) => isExtensionIcon(link.href))) return;
  links.forEach((link) => link.remove());
  githubIcons.forEach((link) => document.head.appendChild(link.cloneNode(true)));
}

function iconFor(status) {
  if (status === "approved") return chrome.runtime.getURL("images/approved_icon.png");
  if (status === "merged") return chrome.runtime.getURL("images/merged_icon.png");
  return null;
}

function sync() {
  refreshSnapshot();
  const href = iconFor(displayedStatus());
  if (href) showExtensionIcon(href);
  else showGitHubIcon();
}

function watch() {
  for (const event of ["turbo:load", "turbo:render", "turbo:frame-load", "soft-nav:end"]) {
    document.addEventListener(event, sync);
  }
  window.addEventListener("popstate", sync);
  if (window.navigation) window.navigation.addEventListener("navigatesuccess", sync);
  setInterval(sync, 1000);
  sync();
}

if (globalThis.chrome?.runtime?.id) watch();
