/**
 * LinkedIn action implementations — ported from platform/scripts/linkedin-poster/src/poster.cjs.
 * Uses Playwright Page instead of agent-browser CLI. Business logic preserved verbatim.
 */

import { readFileSync, existsSync } from 'fs';
import type { Page } from 'playwright';
import type { ActionResult } from './types.js';

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

  console.log('[actions] Opening LinkedIn feed to publish post…');
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForTimeout(2000);
  await checkSession(page);

  // Click "Start a post" button — may be inside shadow DOM
  const startPostClicked = await page.evaluate(() => {
    // Try light DOM first
    const btns = Array.from(document.querySelectorAll('button'));
    const startBtn = btns.find(b => /Start a post/i.test(b.textContent ?? ''));
    if (startBtn) { startBtn.click(); return 'light-dom'; }
    // Try interop-outlet shadow
    const outlet = document.querySelector('#interop-outlet');
    const shadow = outlet?.shadowRoot;
    if (shadow) {
      const shadowBtns = Array.from(shadow.querySelectorAll('button'));
      const shadowStart = shadowBtns.find(b => /Start a post/i.test(b.textContent ?? ''));
      if (shadowStart) { shadowStart.click(); return 'shadow-dom'; }
    }
    return 'not-found';
  });
  if (startPostClicked === 'not-found') {
    throw new Error("Could not find 'Start a post' button. LinkedIn layout may have changed.");
  }
  console.log(`[actions] Start a post clicked via ${startPostClicked}`);
  await page.waitForTimeout(1500);

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
  await page.waitForTimeout(3000);
  return { success: true };
}
