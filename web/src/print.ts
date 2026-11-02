/**
 * PDF export. The desktop prints this same HTML with headless Chromium; a page
 * can't do that silently, so the browser's print dialog does it, with "Save as
 * PDF" as the destination. Printing the exact export document (not the live
 * editor) keeps the page size, margins and footers from Settings.
 */
export function exportPdf(html: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
    frame.srcdoc = html;
    frame.onload = async () => {
      try {
        const win = frame.contentWindow!;
        await frame.contentDocument?.fonts?.ready;
        // Printing needs focus in the frame. Hand it back, or keys typed after
        // the dialog go to a hidden page and every shortcut stops working.
        const editing = document.activeElement as HTMLElement | null;
        const refocus = () => { window.focus(); editing?.focus(); };
        win.addEventListener("afterprint", () => { refocus(); setTimeout(() => frame.remove(), 500); }, { once: true });
        win.focus();
        win.print();
        refocus();
        resolve();
      } catch (error) {
        frame.remove();
        reject(error);
      }
    };
    document.body.appendChild(frame);
  });
}
