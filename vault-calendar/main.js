const { Plugin, ItemView, SuggestModal } = require("obsidian");
const { ViewPlugin, Decoration } = require("@codemirror/view");

const VIEW_TYPE = "vault-calendar-view";
const DATE_PATTERN = /(^|[^\d])(\d{2}\.\d{2}\.(?:\d{4}|\d{2}))(?:\(([GSTW])\))?(?!\d)/g;

function dateKey(year, month, day) {
    return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function validDate(year, month, day) {
    const d = new Date(Date.UTC(year, month, day));
    return d.getUTCFullYear() === year && d.getUTCMonth() === month && d.getUTCDate() === day;
}

function parseDate(dayText, monthText, yearText) {
    const day = Number(dayText);
    const month = Number(monthText) - 1;
    let year = Number(yearText);
    if (yearText.length === 2) year += 2000;
    if (!validDate(year, month, day)) return null;
    return dateKey(year, month, day);
}

function statusClass(status) {
    return `vc-date-status-${status || "none"}`;
}

function extractDates(text) {
    const found = new Map();
    DATE_PATTERN.lastIndex = 0;
    let match;

    while ((match = DATE_PATTERN.exec(text)) !== null) {
        const parts = match[2].split(".");
        const key = parseDate(parts[0], parts[1], parts[2]);
        if (!key) continue;

        const previous = found.get(key) || "";
        // Ein Geburtstag hat Vorrang, damit er zuverlässig jährlich wiederholt wird.
        found.set(key, match[3] === "G" || previous === "G" ? "G" : (match[3] || previous));
    }
    return found;
}

function extractDailyDate(basename) {
    let match = basename.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) {
        const [, y, m, d] = match;
        if (validDate(Number(y), Number(m) - 1, Number(d))) {
            return dateKey(Number(y), Number(m) - 1, Number(d));
        }
    }

    match = basename.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (match) return parseDate(match[1], match[2], match[3]);
    return null;
}

function addDate(map, key, file, status = "") {
    if (!map.has(key)) map.set(key, new Map());
    const files = map.get(key);
    const existing = files.get(file.path);
    let finalStatus = status || (existing && existing.status) || "";
    if (status === "G" || (existing && existing.status === "G")) finalStatus = "G";
    files.set(file.path, { file, status: finalStatus });
}

function buildDateDecorations(view) {
    const decorations = [];
    const text = view.state.doc.toString();
    DATE_PATTERN.lastIndex = 0;
    let match;

    while ((match = DATE_PATTERN.exec(text)) !== null) {
        const parts = match[2].split(".");
        if (!parseDate(parts[0], parts[1], parts[2])) continue;
        const from = match.index + match[1].length;
        const suffixLength = match[3] ? match[3].length + 2 : 0;
        const to = from + match[2].length + suffixLength;
        decorations.push(Decoration.mark({
            class: `vc-date-highlight ${statusClass(match[3] || "")}`
        }).range(from, to));
    }
    return Decoration.set(decorations, true);
}

const dateHighlightExtension = ViewPlugin.fromClass(class {
    constructor(view) {
        this.decorations = buildDateDecorations(view);
    }
    update(update) {
        if (update.docChanged || update.viewportChanged) {
            this.decorations = buildDateDecorations(update.view);
        }
    }
}, {
    decorations: value => value.decorations
});

class DateStatusModal extends SuggestModal {
    constructor(app, editor) {
        super(app);
        this.editor = editor;
        this.options = [
            { label: "Geburtstag (G) – Pink, jährlich wiederkehrend", code: "G" },
            { label: "Termin (T) – Dunkelgrün", code: "T" },
            { label: "Stand (S) – Grau", code: "S" },
            { label: "Wichtig (W) – Rot", code: "W" },
            { label: "Ohne Status – Lila", code: "" }
        ];
        this.setPlaceholder("Status für das Datum auswählen …");
    }

    getSuggestions(query) {
        return this.options.filter(option => option.label.toLowerCase().includes(query.toLowerCase()));
    }

    renderSuggestion(option, el) {
        el.setText(option.label);
    }

    onChooseSuggestion(option) {
        const editor = this.editor;
        if (!editor) return;

        const selected = editor.getSelection().trim();
        let date;
        if (/^\d{2}\.\d{2}\.(?:\d{2}|\d{4})(?:\([GSTW]\))?$/.test(selected)) {
            date = selected.replace(/\([GSTW]\)$/, "");
            const [d, m, y] = date.split(".");
            if (!parseDate(d, m, y)) return;
        } else {
            const now = new Date();
            date = `${String(now.getDate()).padStart(2, "0")}.${String(now.getMonth() + 1).padStart(2, "0")}.${now.getFullYear()}`;
        }
        editor.replaceSelection(date + (option.code ? `(${option.code})` : ""));
    }
}

class VaultCalendarView extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        const now = new Date();
        this.year = now.getFullYear();
        this.month = now.getMonth();
        this.entries = new Map();
        this.recurringBirthdays = new Map();
    }

    getViewType() { return VIEW_TYPE; }
    getDisplayText() { return "Vault Calendar"; }
    getIcon() { return "calendar-days"; }

    async onOpen() {
        this.render();
        await this.refresh();
    }

    async refresh() {
        const files = this.app.vault.getMarkdownFiles();
        const entries = new Map();
        const recurringBirthdays = new Map();

        for (const file of files) {
            try {
                const content = await this.app.vault.cachedRead(file);
                for (const [key, status] of extractDates(content)) {
                    addDate(entries, key, file, status);
                    if (status === "G") {
                        const monthDay = key.slice(5); // MM-DD, unabhängig vom gespeicherten Jahr
                        if (!recurringBirthdays.has(monthDay)) recurringBirthdays.set(monthDay, new Map());
                        recurringBirthdays.get(monthDay).set(file.path, { file, status: "G" });
                    }
                }

                const dailyDate = extractDailyDate(file.basename);
                if (dailyDate) addDate(entries, dailyDate, file, "");
            } catch (error) {
                console.error("Vault Calendar:", file.path, error);
            }
        }

        this.entries = entries;
        this.recurringBirthdays = recurringBirthdays;
        this.render();
    }

    render() {
        const root = this.containerEl.children[1];
        root.empty();
        root.addClass("vault-calendar");

        const header = root.createDiv({ cls: "vc-header" });
        const previous = header.createEl("button", { text: "‹" });
        previous.addEventListener("click", () => {
            this.month--;
            if (this.month < 0) { this.month = 11; this.year--; }
            this.render();
        });

        header.createEl("h2", { text: new Date(this.year, this.month, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" }) });
        const next = header.createEl("button", { text: "›" });
        next.addEventListener("click", () => {
            this.month++;
            if (this.month > 11) { this.month = 0; this.year++; }
            this.render();
        });
        const today = header.createEl("button", { text: "Heute" });
        today.addEventListener("click", () => {
            const now = new Date();
            this.year = now.getFullYear();
            this.month = now.getMonth();
            this.render();
        });

        const grid = root.createDiv({ cls: "vc-grid" });
        for (const day of ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]) {
            grid.createDiv({ cls: "vc-weekday", text: day });
        }

        const firstDay = new Date(this.year, this.month, 1);
        const offset = (firstDay.getDay() + 6) % 7;
        const daysInMonth = new Date(this.year, this.month + 1, 0).getDate();
        for (let i = 0; i < offset; i++) grid.createDiv({ cls: "vc-empty" });

        for (let day = 1; day <= daysInMonth; day++) {
            const key = dateKey(this.year, this.month, day);
            const cell = grid.createDiv({ cls: "vc-day" });
            cell.createDiv({ cls: "vc-day-number", text: String(day) });

            // Normale Termine gelten nur für ihr konkretes Jahr.
            const dayEntries = new Map(this.entries.get(key) || []);
            // Geburtstage werden unbegrenzt jährlich anhand von Monat und Tag wiederholt.
            const monthDay = `${String(this.month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
            const birthdays = this.recurringBirthdays.get(monthDay);
            if (birthdays) {
                for (const [path, entry] of birthdays) dayEntries.set(path, entry);
            }

            for (const entry of dayEntries.values()) {
                const dot = cell.createEl("span", { cls: `vc-entry-dot vc-entry-dot-${entry.status || "none".toLowerCase()}` });
                dot.setAttr("title", entry.file.basename);
                dot.setAttr("aria-label", entry.file.basename);
                dot.addEventListener("click", async event => {
                    event.stopPropagation();
                    const leaf = this.app.workspace.getLeaf(false);
                    await leaf.openFile(entry.file);
                });
            }
        }
    }
}

module.exports = class VaultCalendarPlugin extends Plugin {
    async onload() {
        this.registerEditorExtension(dateHighlightExtension);
        this.registerMarkdownPostProcessor((element) => {
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            const nodes = [];
            while (walker.nextNode()) {
                const node = walker.currentNode;
                if (node.parentElement?.closest("code, pre, .vc-date-highlight")) continue;
                if (/\d{2}\.\d{2}\.(?:\d{4}|\d{2})/.test(node.nodeValue || "")) nodes.push(node);
            }

            for (const node of nodes) {
                const source = node.nodeValue;
                const fragment = document.createDocumentFragment();
                DATE_PATTERN.lastIndex = 0;
                let lastIndex = 0;
                let match;
                while ((match = DATE_PATTERN.exec(source)) !== null) {
                    const parts = match[2].split(".");
                    if (!parseDate(parts[0], parts[1], parts[2])) continue;
                    const from = match.index + match[1].length;
                    const suffixLength = match[3] ? match[3].length + 2 : 0;
                    const to = from + match[2].length + suffixLength;
                    if (from > lastIndex) fragment.appendChild(document.createTextNode(source.slice(lastIndex, from)));

                    const span = document.createElement("span");
                    span.className = `vc-date-highlight ${statusClass(match[3] || "")}`;
                    // In der Leseansicht wird nur das Datum angezeigt, nicht (G), (T), (S) oder (W).
                    span.textContent = match[2];
                    fragment.appendChild(span);
                    lastIndex = to;
                }
                if (lastIndex === 0) continue;
                if (lastIndex < source.length) fragment.appendChild(document.createTextNode(source.slice(lastIndex)));
                node.parentNode.replaceChild(fragment, node);
            }
        });

        this.registerView(VIEW_TYPE, leaf => new VaultCalendarView(leaf, this));
        this.addRibbonIcon("calendar-days", "Open Vault Calendar", () => this.activateView());
        this.addCommand({ id: "open-vault-calendar", name: "Open Vault Calendar", callback: () => this.activateView() });
        this.addCommand({
            id: "insert-date-with-status",
            name: "Datum mit Status einfügen",
            editorCallback: editor => new DateStatusModal(this.app, editor).open()
        });

        const refresh = () => {
            for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
                if (leaf.view instanceof VaultCalendarView) leaf.view.refresh();
            }
        };
        this.registerEvent(this.app.vault.on("modify", refresh));
        this.registerEvent(this.app.vault.on("create", refresh));
        this.registerEvent(this.app.vault.on("delete", refresh));
        this.registerEvent(this.app.vault.on("rename", refresh));
    }

    async activateView() {
        let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
        if (!leaf) {
            leaf = this.app.workspace.getRightLeaf(false);
            await leaf.setViewState({ type: VIEW_TYPE, active: true });
        }
        this.app.workspace.revealLeaf(leaf);
    }

    onunload() {
        this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    }
};
