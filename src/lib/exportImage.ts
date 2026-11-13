import { toBlob, toPng } from 'html-to-image';

const opts = { backgroundColor: '#0c0c0c', pixelRatio: 2, cacheBust: true };

export async function downloadPng(node: HTMLElement, filename: string) {
  const url = await toPng(node, opts);
  const a = document.createElement('a');
  a.href = url; a.download = filename.endsWith('.png') ? filename : `${filename}.png`;
  a.click();
}

export async function copyPng(node: HTMLElement) {
  const blob = await toBlob(node, opts);
  if (!blob) throw new Error('Could not render image.');
  if (!('ClipboardItem' in window) || !navigator.clipboard?.write) throw new Error('Clipboard images are not supported in this browser — use Download.');
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}
