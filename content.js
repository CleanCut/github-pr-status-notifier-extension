const ICON_MARKER = "data-pr-status-notifier";
const LOOKUP_TTL_MS = 30000;
let githubIcons = [];

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

function reviewApproved(root) {
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
  return approved && !changes;
}

function sidebarPresent() {
  return document.querySelector("#partial-discussion-sidebar, #pr-conversation-sidebar") !== null;
}

// Returns a function that gives the value `load` last resolved to for a pull request (null before
// the first), and starts a new load once that value is LOOKUP_TTL_MS old. Each new value goes to
// `onLoad` with the time its load started. A load that rejects logs a warning, keeps the last
// value, and waits out the TTL to retry.
function cachedLookup(load, onLoad = () => {}) {
  let entry = { key: null, value: null, at: 0 };
  let loading = false;
  return (parts) => {
    const fresh = entry.key === parts.key && Date.now() - entry.at < LOOKUP_TTL_MS;
    if (!fresh && !loading) {
      const key = parts.key;
      const startedAt = Date.now();
      const keepValue = () => {
        entry = { key, value: entry.key === key ? entry.value : null, at: Date.now() };
      };
      loading = true;
      load(parts)
        .then((value) => {
          if (pullParts()?.key !== key) return;
          entry = { key, value, at: Date.now() };
          onLoad(value, startedAt);
          sync();
        })
        .catch((error) => {
          console.warn("GitHub PR status notifier could not look up a pull request", error);
          if (pullParts()?.key === key) keepValue();
        })
        .finally(() => {
          loading = false;
        });
    }
    return entry.key === parts.key ? entry.value : null;
  };
}

const fetchedApproval = cachedLookup(async ({ owner, repo, number }) => {
  const url = new URL(`https://github.com/${owner}/${repo}/issues/${number}/show_partial`);
  url.searchParams.set("partial", "pull_requests/sidebar/show/reviewers");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GitHub responded ${res.status} to the reviewers sidebar`);
  return reviewApproved(new DOMParser().parseFromString(await res.text(), "text/html"));
});

// Fetches the JSON GitHub's own pull request pages load, which needs the X-Requested-With header.
async function pageData({ owner, repo, number }, path) {
  const res = await fetch(`https://github.com/${owner}/${repo}/pull/${number}/${path}`, {
    headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
  });
  if (!res.ok) throw new Error(`GitHub responded ${res.status} to ${path}`);
  return res.json();
}

// The number of threads or conversation items GitHub returns per request.
const PAGE_SIZE = 40;

// Resolves to every review thread, fetching the pages after the first.
async function allThreads(parts) {
  const threads = [];
  let page;
  do {
    const after = threads.length > 0 ? `?after=${threads.at(-1).id}` : "";
    page = (await pageData(parts, `page_data/threads${after}`)).threads;
    threads.push(...page);
  } while (page.length >= PAGE_SIZE);
  return threads;
}

// Resolves to the conversation's items newest first, down to the first one older than `since`.
async function conversationSince(parts, since) {
  const items = [];
  let page;
  do {
    const oldest = items.at(-1);
    const cursor = oldest && encodeURIComponent(conversationCursor(oldest));
    const after = cursor ? `&after=${cursor}` : "";
    page = (await pageData(parts, `page_data/conversation_comments?direction=desc${after}`)).items;
    items.push(...page);
  } while (page.length >= PAGE_SIZE && Date.parse(items.at(-1).createdAt) > since);
  return items;
}

// The cursor GitHub's own page sends for the items older than `item`.
function conversationCursor(item) {
  const publishedAt = new Date(item.publishedAt).toISOString().replace(/\.\d+Z$/, ".000000Z");
  return `${publishedAt}|${item.type}|${item.id}`;
}

async function newestCommitAt(parts) {
  const commits = await pageData(parts, "commits");
  return Math.max(
    ...commits.payload.pullRequestsCommitsRoute.commitGroups
      .flatMap((group) => group.commits)
      .map((commit) => Date.parse(commit.committedDate))
  );
}

// Resolves to the pull request's review status:
// - `authors`: those with feedback waiting, other than the viewer. That is whoever started each
//   unresolved review thread, then each human whose latest visible review requested changes or
//   commented with text after the newest commit.
// - `settled`: whether each review thread is resolved, and each fetched conversation item hidden,
//   keyed by type and ID.
const reviewStatus = cachedLookup(async (parts) => {
  const [threads, since] = await Promise.all([allThreads(parts), newestCommitAt(parts)]);
  const items = await conversationSince(parts, since);

  const authors = [];
  for (const thread of threads) {
    const first = thread.commentsData.comments[0];
    if (!thread.isResolved && first && !first.viewerDidAuthor) authors.push(first.author);
  }

  // A review with no text and no verdict holds only thread comments, which the threads cover.
  const reviewers = new Set();
  for (const item of items) {
    if (item.type !== "review_summary" || item.viewerDidAuthor || !isHuman(item.author)) continue;
    if (item.isHidden || (item.state === "COMMENTED" && !item.body?.trim())) continue;
    if (reviewers.has(item.author.login)) continue;
    reviewers.add(item.author.login);
    const waiting = item.state === "CHANGES_REQUESTED" || item.state === "COMMENTED";
    if (waiting && Date.parse(item.createdAt) > since) authors.push(item.author);
  }

  const settled = new Map([
    ...threads.map((thread) => [`thread:${thread.id}`, thread.isResolved]),
    ...items.map((item) => [`${item.type}:${item.id}`, Boolean(item.isHidden)]),
  ]);
  return { authors, settled };
}, noteReviewStatus);

function isHuman(author) {
  return author?.userType === "human";
}

function extensionImage(name) {
  return chrome.runtime.getURL(`images/${name}`);
}

function displayedIcon(parts) {
  const state = headerState(document);
  if (state === "merged") return extensionImage("merged_icon.png");
  if (state === "closed") return null;
  const sidebar = sidebarPresent();
  // Without the reviewers sidebar, only an open or draft header shows the pull request is open.
  if (!sidebar && state !== "open" && state !== "draft") return null;
  const authors = reviewStatus(parts)?.authors ?? [];
  const human = authors.find((author) => isHuman(author) && author.avatarUrl);
  if (human) return new URL(human.avatarUrl, location.href).href;
  if (authors.length > 0) return extensionImage("feedback_icon.png");
  const approved = sidebar ? reviewApproved(document) : fetchedApproval(parts);
  return approved ? extensionImage("approved_icon.png") : null;
}

function iconLinks() {
  return [
    ...document.querySelectorAll(
      'link[rel="icon"], link[rel="alternate icon"], link[rel="shortcut icon"]'
    ),
  ];
}

function isExtensionIcon(link) {
  return link.hasAttribute(ICON_MARKER);
}

function rememberGitHubIcons() {
  const found = iconLinks().filter((link) => !isExtensionIcon(link));
  if (found.length === 0) return;
  githubIcons = found.map((link) => link.cloneNode(true));
}

function showExtensionIcon(href) {
  rememberGitHubIcons();
  const links = iconLinks();
  if (links.length === 1 && isExtensionIcon(links[0]) && links[0].href === href) return;
  // Leave either icon link in place and the tab can keep showing GitHub's.
  links.forEach((link) => link.remove());
  const link = document.createElement("link");
  link.rel = "icon";
  link.href = href;
  link.setAttribute(ICON_MARKER, "");
  document.head.appendChild(link);
}

function showGitHubIcon() {
  const links = iconLinks();
  // GitHub rewrites its icon links for CI status and dark mode, so leave them alone unless the
  // extension's icon is showing.
  if (githubIcons.length === 0 || !links.some(isExtensionIcon)) return;
  links.forEach((link) => link.remove());
  githubIcons.forEach((link) => document.head.appendChild(link.cloneNode(true)));
}

// GitHub's controls that resolve a review thread or hide a comment, which update the page in
// place.
const SETTLE_CONTROLS = [
  '[data-dd-action-name="pull_requests.thread.resolve"]',
  'button[aria-label^="Resolve conversation"]',
  '[role="menuitem"][aria-label^="Hide comment as"]',
].join(", ");

// How long a use of a settle control in the page stands for a change a fetch has yet to see.
const LOCAL_SETTLE_MS = 2 * LOOKUP_TTL_MS;

// The review status the page shows: the first one fetched after it loaded or navigated to its
// path, updated for each review thread resolved and comment hidden in the page itself
// (`localSettles` holds when each was). `reload` is set once a later fetch finds one resolved or
// hidden elsewhere.
let shownPage = { path: null, since: 0, status: null, localSettles: [], reload: false };

function noteNavigation() {
  if (location.pathname === shownPage.path) return;
  const since = shownPage.path === null ? performance.timeOrigin : Date.now();
  shownPage = { path: location.pathname, since, status: null, localSettles: [], reload: false };
}

function noteSettleControl(event) {
  if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
  if (event.target instanceof Element && event.target.closest(SETTLE_CONTROLS)) {
    shownPage.localSettles.push(Date.now());
  }
}

function noteReviewStatus(status, startedAt) {
  if (startedAt < shownPage.since) return;
  if (!shownPage.status) {
    shownPage.status = status;
    return;
  }
  const settled = newlySettled(shownPage.status, status);
  if (settled === 0) return;
  const local = shownPage.localSettles.filter((at) => Date.now() - at < LOCAL_SETTLE_MS);
  if (settled > local.length) {
    shownPage.reload = true;
    return;
  }
  shownPage.status = status;
  shownPage.localSettles = local.slice(settled);
}

// How many review threads `now` finds resolved, and conversation items hidden, that `shown` lists
// as unresolved or visible.
function newlySettled(shown, now) {
  let count = 0;
  for (const [key, settled] of now.settled) {
    if (settled && shown.settled.get(key) === false) count++;
  }
  return count;
}

// Reloads the page once a review thread was resolved or an item hidden since it was shown, unless
// a text box holds unsubmitted text, in which case a later call tries again.
function reloadWhenSettled() {
  noteNavigation();
  rememberTextBoxDefaults();
  if (shownPage.reload && !unsubmittedText()) location.reload();
}

// The text each text box held when first seen, ignoring whitespace. GitHub's React text areas
// keep `defaultValue` equal to what was typed, so it can't serve as the unedited text.
const textBoxDefaults = new WeakMap();

function textBoxes() {
  return document.querySelectorAll('textarea, [contenteditable]:not([contenteditable="false"])');
}

function textBoxText(box) {
  return (box.tagName === "TEXTAREA" ? box.value : box.textContent).replace(/\s+/g, "");
}

function rememberTextBoxDefaults() {
  for (const box of textBoxes()) {
    if (!textBoxDefaults.has(box)) textBoxDefaults.set(box, textBoxText(box));
  }
}

// Whether a text box holds text the user has typed and not submitted.
function unsubmittedText() {
  return [...textBoxes()].some((box) => textBoxText(box) !== textBoxDefaults.get(box));
}

function sync() {
  const parts = pullParts();
  if (!parts) return showGitHubIcon();
  reloadWhenSettled();
  const href = displayedIcon(parts);
  if (href) showExtensionIcon(href);
  else showGitHubIcon();
}

function watch() {
  for (const event of ["turbo:load", "turbo:render", "turbo:frame-load", "soft-nav:end"]) {
    document.addEventListener(event, sync);
  }
  window.addEventListener("popstate", sync);
  document.addEventListener("click", noteSettleControl, true);
  document.addEventListener("keydown", noteSettleControl, true);
  if (window.navigation) window.navigation.addEventListener("navigatesuccess", sync);
  setInterval(sync, 1000);
  sync();
}

if (globalThis.chrome?.runtime?.id) watch();
