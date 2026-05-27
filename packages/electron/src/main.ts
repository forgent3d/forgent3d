import { createViewer } from '@forgent3d/viewer';
import { initUI } from './ui.js';

const host = document.getElementById('canvas-host');
if (!host) {
  throw new Error('Missing #canvas-host');
}

const viewer = createViewer(host);

initUI(viewer);

window.addEventListener('beforeunload', () => {
  viewer.dispose();
});
