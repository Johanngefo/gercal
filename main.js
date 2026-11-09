const { Plugin, ItemView, SuggestModal, Modal, Setting, Notice, normalizePath } = require("obsidian");
const { ViewPlugin, Decoration } = require("@codemirror/view");

const VIEW_TYPE = "gercal-view";

// Uhrzeit HH:MM bzw. H:MM
const TIME = "(?:[01]?\\d|2[0-3]):[0-5]\\d";
// Gruppen: 1 = Präfix, 2 = Datum, 3 = Status, 4 = Startzeit, 5 = Endzeit
// Beispiele: 02.02.2027(T) 15:00 - 16:00  |  02.02.2027 17:00 - 20:00
const DATE_PATTERN = new RegExp(
    `(^|[^\\d])(\\d{2}\\.\\d{2}\\.(?:\\d{4}|\\d{2}))(?:\\(([GSTW])\\))?(?:[ \\t]+(${TIME})[ \\t]*[-–—][ \\t]*(${TIME}))?(?!\\d)`,
    "g"
);

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

function normalizeTime(text) {
    return text.padStart(5, "0");
}

function toMinutes(text) {
    const [h, m] = text.split(":").map(Number);
    return h * 60 + m;
}

function makeTime(startText, endText) {
    const start = normalizeTime(startText);
    const end = normalizeTime(endText);
    return { start, end, startMin: toMinutes(start), endMin: toMinutes(end) };
}

function formatDuration(time) {
    let minutes = time.endMin - time.startMin;
    if (minutes <= 0) minutes += 24 * 60; // Ende nach Mitternacht
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h && m) return `${h} h ${m} min`;
    if (h) return `${h} h`;
    return `${m} min`;
}

function formatTimeRange(time) {
    return `${time.start}–${time.end}`;
}

function mergeTimes(existing, additional) {
    const result = existing.slice();
    for (const t of additional) {
        if (!result.some(r => r.start === t.start && r.end === t.end)) result.push(t);
    }
    return result;
}

function extractDates(text) {
    // key -> { status, times: [{ start, end, startMin, endMin }] }
    const found = new Map();
    DATE_PATTERN.lastIndex = 0;
    let match;

    while ((match = DATE_PATTERN.exec(text)) !== null) {
        const parts = match[2].split(".");
        const key = parseDate(parts[0], parts[1], parts[2]);
        if (!key) continue;

        const previous = found.get(key) || { status: "", times: [] };
        // Ein Geburtstag hat Vorrang, damit er zuverlässig jährlich wiederholt wird.
        const status = match[3] === "G" || previous.status === "G" ? "G" : (match[3] || previous.status);
        const times = match[4] && match[5]
            ? mergeTimes(previous.times, [makeTime(match[4], match[5])])
            : previous.times;
        found.set(key, { status, times });
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

function addDate(map, key, file, status = "", times = []) {
    if (!map.has(key)) map.set(key, new Map());
    const files = map.get(key);
    const existing = files.get(file.path);
    let finalStatus = status || (existing && existing.status) || "";
    if (status === "G" || (existing && existing.status === "G")) finalStatus = "G";
    const finalTimes = mergeTimes(existing ? existing.times : [], times);
    files.set(file.path, { file, status: finalStatus, times: finalTimes });
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
        const to = match.index + match[0].length; // schließt Status und Uhrzeit ein
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

// Auswählbare Status. "D" (Tagesnotiz, Orange) wird nur automatisch am Dateinamen erkannt.
const STATUS_OPTIONS = [
    { label: "Geburtstag (G) – Pink, jährlich wiederkehrend", code: "G" },
    { label: "Termin (T) – Dunkelgrün", code: "T" },
    { label: "Stand (S) – Grau", code: "S" },
    { label: "Wichtig (W) – Rot", code: "W" },
    { label: "Ohne Status – Lila", code: "" }
];

class DateStatusModal extends SuggestModal {
    constructor(app, editor) {
        super(app);
        this.editor = editor;
        this.options = STATUS_OPTIONS;
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

// Legt die Notiz "DD.MM. Titel" an. Erste Zeile: DD.MM.YYYY(x) HH:MM - HH:MM
async function createEventNote(app, { title, key, status, start, end }) {
    const [y, m, d] = key.split("-");
    const dateText = `${d}.${m}.${y}`;
    const safeTitle = title.replace(/[\\/:*?"<>|#^\[\]]/g, " ").replace(/\s+/g, " ").trim();
    if (!safeTitle) throw new Error("Der Titel enthält keine gültigen Zeichen.");

    const baseName = `${d}.${m}. ${safeTitle}`;
    const parent = app.fileManager.getNewFileParent("");
    let path = normalizePath(`${parent.path}/${baseName}.md`);
    let counter = 2;
    while (app.vault.getAbstractFileByPath(path)) {
        path = normalizePath(`${parent.path}/${baseName} (${counter}).md`);
        counter++;
    }

    let firstLine = dateText;
    if (status) firstLine += `(${status})`;
    if (start && end) firstLine += ` ${start} - ${end}`;
    return app.vault.create(path, firstLine + "\n");
}

class AddEventModal extends Modal {
    constructor(app, key) {
        super(app);
        this.key = key; // YYYY-MM-DD
        this.eventTitle = "";
        this.status = "T";
        this.start = "";
        this.end = "";
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h3", { text: "Termin eintragen" });

        new Setting(contentEl).setName("Titel").addText(text => {
            text.setPlaceholder("Titel des Termins").onChange(value => { this.eventTitle = value; });
            text.inputEl.addEventListener("keydown", event => {
                if (event.key === "Enter") { event.preventDefault(); this.submit(); }
            });
            setTimeout(() => text.inputEl.focus(), 0);
        });

        new Setting(contentEl).setName("Datum").addText(text => {
            text.inputEl.type = "date";
            text.setValue(this.key).onChange(value => { this.key = value; });
        });

        new Setting(contentEl).setName("Status").addDropdown(dropdown => {
            for (const option of STATUS_OPTIONS) dropdown.addOption(option.code || "none", option.label);
            dropdown.setValue(this.status || "none");
            dropdown.onChange(value => { this.status = value === "none" ? "" : value; });
        });

        new Setting(contentEl).setName("Von").setDesc("Optional").addText(text => {
            text.inputEl.type = "time";
            text.onChange(value => { this.start = value; });
        });

        new Setting(contentEl).setName("Bis").setDesc("Optional").addText(text => {
            text.inputEl.type = "time";
            text.onChange(value => { this.end = value; });
        });

        new Setting(contentEl).addButton(button => button
            .setButtonText("Erstellen")
            .setCta()
            .onClick(() => this.submit()));
    }

    async submit() {
        const title = this.eventTitle.trim();
        if (!title) { new Notice("Bitte einen Titel eingeben."); return; }

        const match = this.key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!match || !validDate(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) {
            new Notice("Bitte ein gültiges Datum angeben.");
            return;
        }

        const hasStart = /^\d{2}:\d{2}$/.test(this.start);
        const hasEnd = /^\d{2}:\d{2}$/.test(this.end);
        if (hasStart !== hasEnd) { new Notice("Bitte Von- und Bis-Zeit angeben (oder beide leer lassen)."); return; }

        try {
            const file = await createEventNote(this.app, {
                title,
                key: this.key,
                status: this.status,
                start: hasStart ? this.start : "",
                end: hasEnd ? this.end : ""
            });
            new Notice(`Termin angelegt: ${file.basename}`);
            this.close();
        } catch (error) {
            console.error("GerCal:", error);
            new Notice("Termin konnte nicht angelegt werden: " + error.message);
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}

class GerCalView extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        const now = new Date();
        this.year = now.getFullYear();
        this.month = now.getMonth();
        this.entries = new Map();
        this.recurringBirthdays = new Map();
        this.lastFull = null;
    }

    getViewType() { return VIEW_TYPE; }
    getDisplayText() { return "GerCal"; }
    getIcon() { return "calendar-days"; }

    // true, wenn der Kalender in der Hauptarbeitsfläche (nicht in einer Seitenleiste) liegt
    isFullView() {
        const root = this.leaf.getRoot();
        const workspace = this.app.workspace;
        return root !== workspace.leftSplit && root !== workspace.rightSplit;
    }

    async onOpen() {
        this.registerEvent(this.app.workspace.on("layout-change", () => {
            if (this.isFullView() !== this.lastFull) this.render();
        }));
        this.render();
        await this.refresh();
    }

    async refresh() {
        const files = this.app.vault.getMarkdownFiles();
        const entries = new Map();
        const recurringBirthdays = new Map();

        for (const file of files) {
            try {
                // Tagesnotiz (Dateiname = Datum): Status "D" (Orange). Ein Status aus dem Inhalt hat Vorrang.
                const dailyDate = extractDailyDate(file.basename);
                if (dailyDate) addDate(entries, dailyDate, file, "D");

                const content = await this.app.vault.cachedRead(file);
                for (const [key, info] of extractDates(content)) {
                    addDate(entries, key, file, info.status, info.times);
                    if (info.status === "G") {
                        const monthDay = key.slice(5); // MM-DD, unabhängig vom gespeicherten Jahr
                        if (!recurringBirthdays.has(monthDay)) recurringBirthdays.set(monthDay, new Map());
                        recurringBirthdays.get(monthDay).set(file.path, { file, status: "G", times: [] });
                    }
                }
            } catch (error) {
                console.error("GerCal:", file.path, error);
            }
        }

        this.entries = entries;
        this.recurringBirthdays = recurringBirthdays;
        this.render();
    }

    render() {
        const full = this.isFullView();
        this.lastFull = full;

        const root = this.containerEl.children[1];
        root.empty();
        root.addClass("gercal");
        root.toggleClass("vc-full", full);

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
            const cell = grid.createDiv({ cls: "vc-day vc-day-clickable" });
            cell.createDiv({ cls: "vc-day-number", text: String(day) });
            cell.addEventListener("click", () => new AddEventModal(this.app, key).open());

            // Normale Termine gelten nur für ihr konkretes Jahr.
            const dayEntries = new Map(this.entries.get(key) || []);
            // Geburtstage werden unbegrenzt jährlich anhand von Monat und Tag wiederholt.
            const monthDay = `${String(this.month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
            const birthdays = this.recurringBirthdays.get(monthDay);
            if (birthdays) {
                for (const [path, entry] of birthdays) dayEntries.set(path, entry);
            }

            const timed = [];   // nur in der Vollansicht: Einträge mit Zeitraum
            const untimed = []; // alles andere als Punkt
            for (const entry of dayEntries.values()) {
                if (full && entry.times && entry.times.length) {
                    for (const time of entry.times) timed.push({ entry, time });
                } else {
                    untimed.push(entry);
                }
            }
            timed.sort((a, b) => a.time.startMin - b.time.startMin || a.time.endMin - b.time.endMin);

            for (const entry of untimed) {
                const status = entry.status || "none";
                const dot = cell.createEl("span", { cls: `vc-entry-dot vc-entry-dot-${status}` });
                let title = entry.file.basename;
                if (entry.times && entry.times.length) {
                    title += " – " + entry.times.map(t => `${formatTimeRange(t)} (${formatDuration(t)})`).join(", ");
                }
                dot.setAttr("title", title);
                dot.setAttr("aria-label", title);
                dot.addEventListener("click", async event => {
                    event.stopPropagation();
                    const leaf = this.app.workspace.getLeaf(false);
                    await leaf.openFile(entry.file);
                });
            }

            if (timed.length) {
                const list = cell.createDiv({ cls: "vc-timed-list" });
                for (const { entry, time } of timed) {
                    const status = entry.status || "none";
                    const chip = list.createDiv({ cls: `vc-entry-chip vc-chip-status-${status}` });
                    chip.createSpan({ cls: "vc-chip-time", text: formatTimeRange(time) });
                    chip.createSpan({ cls: "vc-chip-duration", text: formatDuration(time) });
                    chip.createSpan({ cls: "vc-chip-title", text: entry.file.basename });
                    const title = `${entry.file.basename}\n${formatTimeRange(time)} (${formatDuration(time)})`;
                    chip.setAttr("title", title);
                    chip.setAttr("aria-label", title);
                    chip.addEventListener("click", async event => {
                        event.stopPropagation();
                        const leaf = this.app.workspace.getLeaf(false);
                        await leaf.openFile(entry.file);
                    });
                }
            }
        }
    }
}

module.exports = class GerCalPlugin extends Plugin {
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
                    const to = match.index + match[0].length;
                    if (from > lastIndex) fragment.appendChild(document.createTextNode(source.slice(lastIndex, from)));

                    const span = document.createElement("span");
                    span.className = `vc-date-highlight ${statusClass(match[3] || "")}`;
                    // In der Leseansicht wird Datum (und ggf. Uhrzeit) angezeigt, nicht (G), (T), (S) oder (W).
                    span.textContent = match[4] && match[5]
                        ? `${match[2]} ${normalizeTime(match[4])} - ${normalizeTime(match[5])}`
                        : match[2];
                    fragment.appendChild(span);
                    lastIndex = to;
                }
                if (lastIndex === 0) continue;
                if (lastIndex < source.length) fragment.appendChild(document.createTextNode(source.slice(lastIndex)));
                node.parentNode.replaceChild(fragment, node);
            }
        });

        this.registerView(VIEW_TYPE, leaf => new GerCalView(leaf, this));
        this.addRibbonIcon("calendar-days", "Open GerCal", () => this.activateView());
        this.addCommand({ id: "open-gercal", name: "Open GerCal", callback: () => this.activateView() });
        this.addCommand({
            id: "insert-date-with-status",
            name: "Datum mit Status einfügen",
            editorCallback: editor => new DateStatusModal(this.app, editor).open()
        });

        const refresh = () => {
            for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
                if (leaf.view instanceof GerCalView) leaf.view.refresh();
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
