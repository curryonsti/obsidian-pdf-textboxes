import { App, Modal, Setting } from 'obsidian';

/** Small Obsidian-styled yes/no dialog (instead of window.confirm). */
export function confirmDialog(app: App, title: string, body: string, confirmLabel: string): Promise<boolean> {
	return new Promise((resolve) => {
		let answered = false;
		const modal = new (class extends Modal {
			onOpen() {
				this.setTitle(title);
				for (const para of body.split('\n\n')) this.contentEl.createEl('p', { text: para });
				new Setting(this.contentEl)
					.addButton((b) =>
						b.setButtonText('Cancel').onClick(() => {
							this.close();
						}),
					)
					.addButton((b) =>
						b
							.setButtonText(confirmLabel)
							.setDestructive()
							.onClick(() => {
								answered = true;
								resolve(true);
								this.close();
							}),
					);
			}
			onClose() {
				this.contentEl.empty();
				if (!answered) resolve(false);
			}
		})(app);
		modal.open();
	});
}
