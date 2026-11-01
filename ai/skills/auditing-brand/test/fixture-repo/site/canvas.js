const context = canvas.getContext('2d');
context.font = 'bold 12px Inter';
context.fillStyle = '#ff6600';
document.body.style.setProperty('--accent', 'oklch(70% 0.1 200)');
const card = html`<p class="text-sm">Lumen Relay is ready</p>`;
const panel = `<h3 class="text-xs">Status</h3>`;
