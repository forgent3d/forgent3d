import { createViewer } from './viewer.js';
import { initUI } from './ui.js';

const viewer = createViewer(document.getElementById('canvas-host'));

initUI(viewer);

window.addEventListener('beforeunload', () => {
  viewer.dispose();
});
