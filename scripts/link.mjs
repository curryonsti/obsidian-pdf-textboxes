// Symlinks this folder into a vault's .obsidian/plugins/ folder.
// Usage: npm run link -- "/path/to/Vault"
import fs from 'node:fs';
import path from 'node:path';

const here = path.resolve('.');
if (!process.argv[2]) {
	console.error('Usage: npm run link -- "/path/to/your/test vault"');
	process.exit(1);
}
const vault = path.resolve(process.argv[2]);
if (!fs.existsSync(path.join(vault, '.obsidian'))) {
	console.error(`Not a vault (no .obsidian folder): ${vault}`);
	process.exit(1);
}
const pluginsDir = path.join(vault, '.obsidian', 'plugins');
fs.mkdirSync(pluginsDir, { recursive: true });
const target = path.join(pluginsDir, 'pdf-textboxes');
if (fs.existsSync(target) || fs.lstatSync(target, { throwIfNoEntry: false })) {
	const st = fs.lstatSync(target);
	if (st.isSymbolicLink() && fs.realpathSync(target) === here) {
		console.log(`Already linked: ${target}`);
		process.exit(0);
	}
	console.error(`Refusing to replace existing ${target}. Remove it first.`);
	process.exit(1);
}
fs.symlinkSync(here, target, 'dir');
// Hot Reload plugin (pjeby/hot-reload) reloads plugins whose folder has a .hotreload file.
fs.writeFileSync(path.join(here, '.hotreload'), '');
console.log(`Linked ${target} -> ${here}`);
