/**
 * LinkedIn action implementations — ported from platform/scripts/linkedin-poster/src/poster.cjs.
 * Uses Playwright Page instead of agent-browser CLI. Business logic preserved verbatim.
 */

import { readFileSync, existsSync } from 'fs';
import type { Page } from 'playwright';
import type { ActionResult } from './types.js';

export interface DiscoveredPost {
  url: string;
  authorName: string;
  authorUrl: string | null;
  text: string;
  keyword: string;
}

const LOGIN_PATTERN = /log.?in|sign.?in|authwall/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function checkSession(page: Page): Promise<void> {
  const title = await page.title();
  if (LOGIN_PATTERN.test(title)) {
    throw new Error('Not logged into LinkedIn. Run: cortextos bus poster-selfhost login --user <name>');
  }
}

/** Get button text inventory for debugging when expected button is missing. */
async function buttonInventory(page: Page): Promise<string> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('button'))
      .map(b => b.getAttribute('aria-label') || b.textContent?.trim() || '')
      .filter(Boolean)
      .slice(0, 30)
      .join(' | ')
  );
}

// ---------------------------------------------------------------------------
// postLinkedInComment
// ---------------------------------------------------------------------------
export async function postLinkedInComment(
  page: Page,
  postUrl: string,
  commentText: string,
): Promise<ActionResult> {
  console.log(`[actions] Opening post: ${postUrl}`);
  await page.goto(postUrl, { waitUntil: 'networkidle', timeout: 30_000 });
  await checkSession(page);

  // Click the comment area to expand the TipTap editor
  console.log('[actions] Expanding comment box…');
  await page.getByText('Add a comment', { exact: false }).first().click();
  await page.waitForTimeout(1500);

  // Inject text via shadow DOM eval (same approach as Mac poster)
  const safeText = JSON.stringify(commentText);
  const injectResult = await page.evaluate(`
    (function() {
      // Try direct contenteditable first
      const editor = document.querySelector('[contenteditable="true"]');
      if (editor) {
        editor.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, ${safeText});
        return 'ok:' + editor.textContent.length;
      }
      // Try interop-outlet shadow DOM (newer LinkedIn)
      const outlet = document.querySelector('#interop-outlet');
      const shadow = outlet && outlet.shadowRoot;
      if (shadow) {
        const shadowEditor = shadow.querySelector('[contenteditable="true"]');
        if (shadowEditor) {
          shadowEditor.focus();
          document.execCommand('insertText', false, ${safeText});
          return 'shadow-ok:' + shadowEditor.textContent.length;
        }
      }
      return 'no-editor';
    })()`
  ) as string;

  console.log(`[actions] Text injection result: ${injectResult}`);
  if (injectResult.startsWith('no-')) {
    throw new Error(`Could not find TipTap comment editor: ${injectResult}`);
  }

  await page.waitForTimeout(800);

  // Verify content
  const actualText = await page.evaluate(`
    (function() {
      const editor = document.querySelector('[contenteditable="true"]');
      if (editor) return editor.textContent;
      const outlet = document.querySelector('#interop-outlet');
      const shadow = outlet && outlet.shadowRoot;
      if (shadow) {
        const e = shadow.querySelector('[contenteditable="true"]');
        if (e) return e.textContent;
      }
      return '';
    })()`
  ) as string;

  const preview = commentText.substring(0, 30);
  if (!actualText.includes(preview)) {
    throw new Error(`Comment verification failed. Expected "${preview}" but got: "${actualText.substring(0, 60)}"`);
  }
  console.log('[actions] Comment verified in editor.');

  // Click the "Comment" submit button (inline TipTap button, not hidden Submit)
  const commentBtnFound = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const commentBtn = btns.find(b => {
      const text = b.textContent?.trim() ?? '';
      const label = b.getAttribute('aria-label') ?? '';
      return (text === 'Comment' || label === 'Comment') && !/add a comment/i.test(text);
    });
    if (commentBtn) { commentBtn.click(); return true; }
    return false;
  });

  if (!commentBtnFound) {
    console.log('[actions] Comment button not found, using Meta+Return');
    await page.keyboard.press('Meta+Return');
  }

  await page.waitForTimeout(2500);
  console.log('[actions] Comment posted.');
  return { success: true };
}

// ---------------------------------------------------------------------------
// sendConnectionRequest
// ---------------------------------------------------------------------------
export async function sendConnectionRequest(
  page: Page,
  profileUrl: string,
  noteText?: string,
): Promise<ActionResult> {
  console.log(`[actions] Opening profile: ${profileUrl}`);
  await page.goto(profileUrl, { waitUntil: 'networkidle', timeout: 30_000 });
  await checkSession(page);

  // PRE-CHECK: if "Message" button is visible, we're already connected — skip
  const hasMessage = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button')).some(b =>
      /^Message$/.test(b.textContent?.trim() ?? '') ||
      /^Message$/.test(b.getAttribute('aria-label') ?? '')
    )
  );
  if (hasMessage) {
    console.log('[actions] Already connected (Message button found). Skipping connect.');
    return { success: true, skipped: true, reason: 'already_connected' };
  }

  // Find Connect button (may be in a "More" dropdown)
  let hasConnect = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button')).some(b => /\bConnect\b/.test(b.textContent ?? ''))
  );

  if (!hasConnect) {
    // Try opening the "More" dropdown
    const moreClicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => /\bMore\b/i.test(b.getAttribute('aria-label') ?? b.textContent ?? ''));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (moreClicked) {
      await page.waitForTimeout(800);
      hasConnect = await page.evaluate(() =>
        Array.from(document.querySelectorAll('button,[role="menuitem"]')).some(b => /\bConnect\b/.test(b.textContent ?? ''))
      );
    }
  }

  if (!hasConnect) {
    console.log('[actions] No Connect button found. Recording as already connected.');
    return { success: true, skipped: true, reason: 'already_connected' };
  }

  // Click Connect
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button,[role="menuitem"]')).find(b => /\bConnect\b/.test(b.textContent ?? ''));
    (btn as HTMLElement | undefined)?.click();
  });
  await page.waitForTimeout(1000);

  // Modal opens — click "Add a note" if available
  const addNoteClicked = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => /Add a note/i.test(b.textContent ?? ''));
    if (btn) { btn.click(); return true; }
    return false;
  });

  if (!addNoteClicked) {
    // No note option — just send
    const sendClicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => /^Send$/.test(b.textContent?.trim() ?? ''));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (sendClicked) {
      await page.waitForTimeout(1500);
      return { success: true, note: 'Sent without note (Add a note not available)' };
    }
    throw new Error("Could not find 'Add a note' or 'Send' in connection modal.");
  }

  await page.waitForTimeout(800);

  // Fill note textarea (plain textarea, not TipTap)
  const note = (noteText ?? '').substring(0, 300);
  const textareaFilled = await page.evaluate((text: string) => {
    const textarea = document.querySelector('textarea');
    if (!textarea) return false;
    textarea.focus();
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    nativeInputValueSetter?.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, note);

  if (!textareaFilled) {
    throw new Error('Could not find note textarea in connection modal.');
  }
  await page.waitForTimeout(500);

  // Verify note
  const noteActual = await page.evaluate(() => (document.querySelector('textarea') as HTMLTextAreaElement | null)?.value ?? '');
  if (!noteActual.includes(note.substring(0, 20))) {
    throw new Error('Note text verification failed — not sending.');
  }

  // Click Send
  const sendClicked = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => /^Send$/.test(b.textContent?.trim() ?? ''));
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (!sendClicked) throw new Error('Could not find Send button in connection modal.');

  await page.waitForTimeout(2000);
  console.log('[actions] Connection request sent.');
  return { success: true };
}

// ---------------------------------------------------------------------------
// sendDM
// ---------------------------------------------------------------------------
export async function sendDM(
  page: Page,
  profileUrl: string,
  messageText: string,
): Promise<ActionResult> {
  console.log(`[actions] Opening profile for DM: ${profileUrl}`);
  await page.goto(profileUrl, { waitUntil: 'networkidle', timeout: 30_000 });
  await checkSession(page);

  // Find and click Message button
  const msgClicked = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b =>
      /^Message$/.test(b.textContent?.trim() ?? '') || /^Message$/.test(b.getAttribute('aria-label') ?? '')
    );
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (!msgClicked) {
    throw new Error('Could not find Message button. You may not be connected to this person yet.');
  }

  await page.waitForTimeout(1500);

  // Find TipTap editor in messaging overlay
  const injectResult = await page.evaluate((text: string) => {
    const editor = document.querySelector('[contenteditable="true"]') as HTMLElement | null;
    if (!editor) return 'no-editor';
    editor.focus();
    document.execCommand('insertText', false, text);
    return 'ok:' + editor.textContent?.length;
  }, messageText) as string;

  if (injectResult.startsWith('no-')) {
    throw new Error('Could not find DM editor in messaging overlay.');
  }

  await page.waitForTimeout(600);

  // Verify
  const actual = await page.evaluate(() => {
    const editor = document.querySelector('[contenteditable="true"]');
    return (editor as HTMLElement | null)?.textContent ?? '';
  });
  if (!actual.includes(messageText.substring(0, 20))) {
    throw new Error('DM text verification failed — not sending.');
  }

  // Send with Enter
  await page.keyboard.press('Return');
  await page.waitForTimeout(2000);
  console.log('[actions] DM sent.');
  return { success: true };
}

// ---------------------------------------------------------------------------
// publishLinkedInPost
// ---------------------------------------------------------------------------
export async function publishLinkedInPost(
  page: Page,
  postText: string,
  imagePaths: string[] = [],
): Promise<ActionResult> {
  if (imagePaths.length > 20) {
    throw new Error(`Too many images: ${imagePaths.length} (LinkedIn caps at 20)`);
  }

  // Navigate to feed and wait for actual readiness (not just DOMContentLoaded).
  // LinkedIn's React app does client-side navigations after DOMContentLoaded which
  // can destroy the JS execution context mid-evaluate. Use waitForSelector as the
  // readiness gate — it retries internally and survives client-side redirects.
  const navigateAndReady = async (): Promise<void> => {
    console.log('[actions] Opening LinkedIn feed to publish post…');
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Wait for at least one interactive element — proves React has hydrated
    await page.waitForSelector('div[role="button"]', { state: 'visible', timeout: 15_000 });
    await checkSession(page);
  };
  await navigateAndReady();

  // Click "Start a post". LinkedIn 2026 renders this as div[role="button"], not <button>.
  // Use Playwright's locator.click() (real mouse events) rather than element.click() inside
  // evaluate — programmatic clicks can be treated differently by LinkedIn's React event handlers.
  // Wrap in try/catch: retry with re-navigation if execution context is destroyed.
  const clickStartPost = async (): Promise<string> => {
    // Try Playwright locator first (sends real pointer events, most reliable)
    const locator = page.locator('div[role="button"]').filter({ hasText: /^Start a post$/i }).first();
    const locatorCount = await locator.count().catch(() => 0);
    if (locatorCount > 0) {
      await locator.click({ timeout: 5_000 });
      return 'locator-click';
    }
    // Fallback: <button> locator
    const btnLocator = page.getByRole('button', { name: /Start a post/i }).first();
    const btnCount = await btnLocator.count().catch(() => 0);
    if (btnCount > 0) {
      await btnLocator.click({ timeout: 5_000 });
      return 'button-locator';
    }
    // Last resort: evaluate-based click (handles shadow DOM)
    return page.evaluate(() => {
      const outlet = document.querySelector('#interop-outlet');
      const shadow = outlet?.shadowRoot;
      if (shadow) {
        const shadowBtns = Array.from(shadow.querySelectorAll('button, div[role="button"]'));
        const shadowStart = shadowBtns.find(b =>
          /Start a post/i.test((b as HTMLElement).textContent?.trim() ?? '') ||
          /Start a post/i.test(b.getAttribute('aria-label') ?? '')
        );
        if (shadowStart) { (shadowStart as HTMLElement).click(); return 'shadow-dom'; }
      }
      return 'not-found';
    });
  };

  let startPostClicked: string;
  try {
    startPostClicked = await clickStartPost();
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (msg.includes('Execution context was destroyed') || msg.includes('Target closed')) {
      console.warn('[actions] Execution context lost on first attempt — re-navigating and retrying');
      await navigateAndReady();
      startPostClicked = await clickStartPost();
    } else {
      throw err;
    }
  }

  if (startPostClicked === 'not-found') {
    const pageTitle = await page.title();
    throw new Error(`Could not find 'Start a post' button. Page title: "${pageTitle}"`);
  }
  console.log(`[actions] Start a post clicked via ${startPostClicked}`);

  // Wait for the post composer editor to actually appear — shadow DOM or regular DOM.
  // Linux/Xvfb renders slower than Mac — fixed 1500ms is insufficient.
  try {
    await page.waitForFunction(() => {
      // Primary: shadow DOM under #interop-outlet (LinkedIn SDUI)
      const outlet = document.querySelector('#interop-outlet');
      const shadow = (outlet as Element & { shadowRoot: ShadowRoot | null })?.shadowRoot;
      if (shadow?.querySelector('[contenteditable="true"]')) return true;
      // Fallback: regular DOM contenteditable (older LinkedIn layout or different session state)
      return document.querySelectorAll('[contenteditable="true"]').length > 0;
    }, { timeout: 12_000 });
    console.log('[actions] Composer editor ready');
  } catch {
    const pageTitle = await page.title();
    throw new Error(`Composer editor did not appear within 12s. Page title: "${pageTitle}"`);
  }

  // Inject text via shadow DOM (same approach as Mac poster — proven pattern)
  const safeText = JSON.stringify(postText);
  const injectResult = await page.evaluate(`
    (function() {
      const outlet = document.querySelector('#interop-outlet');
      const shadow = outlet && outlet.shadowRoot;
      if (!shadow) return 'no-shadow';
      const editor = shadow.querySelector('[contenteditable="true"]');
      if (!editor) return 'no-editor';
      editor.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, ${safeText});
      return 'ok:' + editor.textContent.length;
    })()`
  ) as string;

  console.log(`[actions] Text injection result: ${injectResult}`);
  if (injectResult.startsWith('no-')) {
    throw new Error(`Could not inject text into composer: ${injectResult}`);
  }
  await page.waitForTimeout(800);

  // Attach images if provided
  if (imagePaths.length > 0) {
    const imgs = imagePaths.map((p, i) => {
      if (!existsSync(p)) throw new Error(`Image not found at ${p}`);
      const bytes = readFileSync(p);
      return { name: `post-image-${i + 1}.png`, base64: bytes.toString('base64'), size: bytes.length };
    });
    const totalBytes = imgs.reduce((sum, i) => sum + i.size, 0);
    console.log(`[actions] Attaching ${imgs.length} image(s) (${totalBytes} bytes total)`);

    // Click Add media button in shadow DOM
    const mediaClickResult = await page.evaluate(() => {
      const outlet = document.querySelector('#interop-outlet');
      const shadow = outlet?.shadowRoot;
      if (!shadow) return 'no-shadow';
      const buttons = Array.from(shadow.querySelectorAll('button'));
      const mediaBtn = buttons.find(b => {
        const label = (b.getAttribute('aria-label') ?? '').toLowerCase();
        return label.includes('add media') || label === 'photo' || label.includes('add a photo');
      });
      if (!mediaBtn) {
        const inventory = buttons.map(b => b.getAttribute('aria-label') || b.textContent?.trim().slice(0, 30)).filter(Boolean).join(' | ');
        return 'no-media-btn::' + inventory.slice(0, 800);
      }
      mediaBtn.click();
      return 'media-btn-clicked';
    });
    console.log(`[actions] Media button click: ${mediaClickResult}`);
    if (mediaClickResult.startsWith('no-')) {
      throw new Error(`Could not find Add Media button: ${mediaClickResult}`);
    }

    await page.waitForTimeout(1200);

    // Upload images via DataTransfer on file input
    const imgsPayload = JSON.stringify(imgs.map(i => ({ name: i.name, base64: i.base64 })));
    const uploadResult = await page.evaluate(`
      (function() {
        function findFileInput(root) {
          if (!root) return null;
          const direct = root.querySelectorAll ? root.querySelectorAll('input[type="file"]') : [];
          if (direct.length) return direct[0];
          const children = root.querySelectorAll ? root.querySelectorAll('*') : [];
          for (const el of children) {
            if (el.shadowRoot) {
              const inner = findFileInput(el.shadowRoot);
              if (inner) return inner;
            }
          }
          return null;
        }
        const outlet = document.querySelector('#interop-outlet');
        const shadow = outlet && outlet.shadowRoot;
        const input = findFileInput(shadow) || findFileInput(document);
        if (!input) return 'no-file-input';
        const items = ${imgsPayload};
        const dt = new DataTransfer();
        for (const img of items) {
          const bytes = Uint8Array.from(atob(img.base64), c => c.charCodeAt(0));
          dt.items.add(new File([bytes], img.name, { type: 'image/png' }));
        }
        Object.defineProperty(input, 'files', { value: dt.files, writable: false });
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return 'uploaded:' + items.length;
      })()`
    ) as string;
    console.log(`[actions] Upload result: ${uploadResult}`);
    if (uploadResult.startsWith('no-')) {
      throw new Error(`File input not found: ${uploadResult}`);
    }
    await page.waitForTimeout(3000);
  }

  // Intercept LinkedIn's share-creation API response to capture the post URN.
  // LinkedIn POSTs to /voyager/api/contentcreation/normShares (or similar) when
  // the Post button is clicked; the response JSON contains the share URN.
  let capturedUrn: string | undefined;
  const urnListener = async (response: import('playwright').Response) => {
    if (capturedUrn) return;
    try {
      const url = response.url();
      if (!url.includes('linkedin.com')) return;
      if (response.status() < 200 || response.status() >= 300) return;
      // Scan ALL LinkedIn API responses (not just known endpoints) for the share URN.
      // We log the URL when we find a URN so we can narrow the filter later.
      const body = await response.text().catch(() => '');
      const match = body.match(/urn:li:share:\d+/);
      if (match) {
        capturedUrn = match[0];
        console.log(`[actions] Captured share URN from network: ${capturedUrn} (endpoint: ${url.split('?')[0]})`);
      }
    } catch { /* non-fatal */ }
  };
  page.on('response', urnListener);

  // Click Post button in shadow DOM
  const postClicked = await page.evaluate(() => {
    const outlet = document.querySelector('#interop-outlet');
    const shadow = outlet?.shadowRoot;
    if (shadow) {
      const btns = Array.from(shadow.querySelectorAll('button'));
      const postBtn = btns.find(b => /^Post$/.test(b.textContent?.trim() ?? ''));
      if (postBtn) { postBtn.click(); return 'shadow-post'; }
    }
    // Fallback: light DOM
    const lightBtn = Array.from(document.querySelectorAll('button')).find(b => /^Post$/.test(b.textContent?.trim() ?? ''));
    if (lightBtn) { lightBtn.click(); return 'light-post'; }
    return 'no-post-btn';
  });
  if (postClicked === 'no-post-btn') {
    throw new Error("Could not find 'Post' button in composer.");
  }
  console.log(`[actions] Post submitted via ${postClicked}`);

  // Give LinkedIn time to complete the API call and return the URN
  await page.waitForTimeout(6000);
  page.off('response', urnListener);

  // Build permalink from URN if captured
  const linkedin_post_id = capturedUrn
    ? `https://www.linkedin.com/feed/update/${capturedUrn}`
    : undefined;

  if (linkedin_post_id) {
    console.log(`[actions] Permalink: ${linkedin_post_id}`);
  } else {
    console.warn('[actions] Share URN not captured from network — post published but permalink unknown');
  }

  return { success: true, ...(linkedin_post_id ? { linkedin_post_id } : {}) };
}

// ---------------------------------------------------------------------------
// discoverLinkedInPosts
// ---------------------------------------------------------------------------

/**
 * Discover LinkedIn posts for the given keywords.
 *
 * Requires headed browser mode (DISPLAY env var set, Xvfb running). LinkedIn's
 * SDUI does not render feed content in headless Chrome, so DOM extraction only
 * works when the browser is visible to an X11 display.
 *
 * Flow: navigate LinkedIn content search → wait for SDUI render → scroll to
 * load more → extract post cards from DOM (data-urn + author link + text).
 */
export async function discoverLinkedInPosts(
  page: Page,
  keywords: string[],
  limit: number = 10,
): Promise<DiscoveredPost[]> {
  const all: DiscoveredPost[] = [];
  const seenUrn = new Set<string>();
  const headed = !!process.env['DISPLAY'];
  console.log(`[discover] Mode: ${headed ? 'headed (Xvfb)' : 'headless'}`);

  for (const keyword of keywords.slice(0, 6)) {
    if (all.length >= limit) break;

    // LinkedIn content search sorted by recency — proven to return relevant posts
    const searchUrl = `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(keyword)}&sortBy=date_posted`;
    console.log(`[discover] Searching: "${keyword}"`);

    try {
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await checkSession(page);

      // Give SDUI time to render post cards (headed mode renders them; headless does not)
      await page.waitForTimeout(3000);

      // Scroll to trigger additional post cards to load
      for (let i = 0; i < 4; i++) {
        await page.evaluate(() => window.scrollBy(0, 700));
        await page.waitForTimeout(1000);
      }

      // Extract post cards from DOM.
      // LinkedIn renders "Feed post" heading (H2) as the first text in each post card.
      // We find the smallest div whose text starts with "Feed post" to isolate each card,
      // then extract author, URL, and post body from its children.
      type RawExtracted = {
        url: string;
        authorName: string;
        authorUrl: string | null;
        text: string;
      };
      const extracted: RawExtracted[] = await page.evaluate(() => {
        const results: RawExtracted[] = [];
        const seenUrls = new Set<string>();

        // Find post card containers: divs whose text starts with "Feed post" where
        // the parent div does NOT also start with "Feed post" (gives us the card root).
        const allDivs = Array.from(document.querySelectorAll('div'));
        const feedCards = allDivs.filter(el => {
          const text = el.textContent?.trim() ?? '';
          if (!text.startsWith('Feed post')) return false;
          const parentText = el.parentElement?.textContent?.trim() ?? '';
          return !parentText.startsWith('Feed post');
        });

        for (const el of feedCards.slice(0, 15)) {
          // Post URL: timestamp link goes to the full post (uses /feed/update/ path)
          const updateLink = el.querySelector('a[href*="/feed/update/"]') as HTMLAnchorElement | null;
          const url = updateLink?.href?.split('?')[0] ?? '';

          // Author: first /in/ or /company/ link in the card
          const authorLink = el.querySelector('a[href*="/in/"], a[href*="/company/"]') as HTMLAnchorElement | null;
          const authorUrl = authorLink?.href?.split('?')[0] ?? null;

          // Author name: first short paragraph (name, not job title, not degree marker)
          const allPs = Array.from(el.querySelectorAll('p'));
          const nameP = allPs.find(p => {
            const t = p.textContent?.trim() ?? '';
            return t.length >= 2 && t.length <= 80 && !t.startsWith('•') && !/^\d/.test(t) && !/^Follow$/.test(t);
          });
          const authorName = nameP?.textContent?.trim() ?? '';

          // Post text: find the Follow button, then take the first long paragraph after it.
          // Fallback: longest paragraph > 60 chars that isn't author name or job title.
          const followBtn = Array.from(el.querySelectorAll('button')).find(b =>
            /^Follow$/i.test(b.textContent?.trim() ?? '')
          );
          let postText = '';
          if (followBtn) {
            const psAfter = allPs.filter(p =>
              followBtn.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING
            );
            postText = psAfter
              .map(p => p.textContent?.trim() ?? '')
              .filter(t => t.length > 60 && t !== authorName && !/^\d+[mhdw]/.test(t))
              .sort((a, b) => b.length - a.length)[0] ?? '';
          }
          if (!postText) {
            // Fallback: longest paragraph in the whole card
            postText = allPs
              .map(p => p.textContent?.trim() ?? '')
              .filter(t => t.length > 80 && t !== authorName && !/^\d+[mhdw]/.test(t) && !t.startsWith('•'))
              .sort((a, b) => b.length - a.length)[0] ?? '';
          }

          if (authorName.length >= 2 && postText.length > 0) {
            const key = url || authorName + postText.substring(0, 20);
            if (seenUrls.has(key)) continue;
            seenUrls.add(key);
            results.push({ url, authorName, authorUrl, text: postText.substring(0, 500) });
          }
        }

        return results;
      });

      console.log(`[discover] "${keyword}": ${extracted.length} posts from DOM extraction`);

      for (const p of extracted) {
        if (all.length >= limit) break;
        const key = p.url || `${p.authorName}:${p.text.substring(0, 20)}`;
        if (seenUrn.has(key)) continue;
        seenUrn.add(key);
        all.push({
          url: p.url,
          authorName: p.authorName,
          authorUrl: p.authorUrl,
          text: p.text,
          keyword,
        });
      }
    } catch (err) {
      console.error(`[discover] Error for "${keyword}": ${(err as Error).message}`);
    }
  }

  console.log(`[discover] Total: ${all.length} posts discovered`);
  return all;
}
