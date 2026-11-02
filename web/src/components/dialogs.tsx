/**
 * The browser has no save-to-a-path dialog, so these stand in for the native
 * ones: they choose among folders in the workspace, and can hand off to the
 * operating system's picker where the browser has one.
 */
import { For, Show, createSignal, onMount, untrack } from "solid-js";
import ModalFrame from "../../../src/components/ModalFrame";
import { confirmDialog } from "../../../src/platform";
import { exists, LIBRARY, mountFile, needsAccess, reconnectAll, writableFolders } from "../vfs";

interface Request {
  mode: "save" | "folder";
  title: string;
  name: string;
  folder: string;
  resolve(path: string | null): void;
}

const [request, setRequest] = createSignal<Request | null>(null);

export function askSavePath(name: string, folder: string, title: string): Promise<string | null> {
  return new Promise((resolve) => setRequest({ mode: "save", title, name, folder, resolve }));
}

export function askFolder(title: string): Promise<string | null> {
  return new Promise((resolve) => setRequest({ mode: "folder", title, name: "", folder: LIBRARY, resolve }));
}

/** "/Folders/Notes/2026" reads as "This device / Notes / 2026". */
const label = (path: string) => path.replace(/^\/Folders/, "This device").replace(/^\/Library/, "Library").split("/").join(" / ");

function PathDialog(props: { req: Request }) {
  // Keyed by its request in Overlays, so a new request is a new dialog.
  const initial = untrack(() => props.req);
  const [name, setName] = createSignal(initial.name);
  const [folder, setFolder] = createSignal(initial.folder);
  const [sub, setSub] = createSignal("");
  const [folders, setFolders] = createSignal<string[]>([initial.folder]);
  let input: HTMLInputElement | undefined;

  onMount(async () => {
    const all = await writableFolders();
    setFolders(all.includes(props.req.folder) ? all : [...all, props.req.folder]);
    if (input) {
      input.focus();
      input.setSelectionRange(0, name().lastIndexOf(".") > 0 ? name().lastIndexOf(".") : name().length);
    }
  });

  const finish = (path: string | null) => {
    setRequest(null);
    props.req.resolve(path);
  };
  const cleaned = () => name().trim().replace(/[\\/]/g, "-");
  const fullName = () => (/\.[a-z0-9]+$/i.test(cleaned()) ? cleaned() : `${cleaned()}.md`);
  const target = () => {
    const extra = sub().trim().replace(/^\/+|\/+$/g, "").replace(/\.\.+/g, "");
    return extra ? `${folder()}/${extra}` : folder();
  };

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    if (props.req.mode === "folder") { finish(target()); return; }
    if (!cleaned()) { input?.focus(); return; }
    const path = `${target()}/${fullName()}`;
    if (path !== `${props.req.folder}/${props.req.name}` && (await exists(path)) &&
      !(await confirmDialog(`${fullName()} already exists. Replace it?`))) return;
    finish(path);
  };

  const pickOnDevice = async () => {
    try {
      const handle = await window.showSaveFilePicker!({ suggestedName: fullName() });
      finish(await mountFile(handle));
    } catch { /* cancelled: stay in the dialog */ }
  };

  return (
    <div class="table-dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && finish(null)}>
      <ModalFrame class="table-dialog web-path-dialog" label={props.req.title} onClose={() => finish(null)}>
        <form onSubmit={(e) => void submit(e)} noValidate>
          <div class="table-dialog-heading"><div><h2>{props.req.title}</h2></div></div>
          <div class="web-path-fields">
            <Show when={props.req.mode === "save"}>
              <label for="web-path-name">Name
                <input ref={input} id="web-path-name" type="text" spellcheck={false} autocomplete="off"
                  value={name()} onInput={(e) => setName(e.currentTarget.value)} />
              </label>
            </Show>
            <label for="web-path-folder">Folder
              <select id="web-path-folder" value={folder()} onChange={(e) => setFolder(e.currentTarget.value)}>
                <For each={folders()}>{(f) => <option value={f} selected={f === folder()}>{label(f)}</option>}</For>
              </select>
            </label>
            <label for="web-path-sub">New folder inside it (optional)
              <input id="web-path-sub" type="text" spellcheck={false} autocomplete="off"
                value={sub()} onInput={(e) => setSub(e.currentTarget.value)} />
            </label>
          </div>
          <div class="table-dialog-actions web-path-actions">
            <Show when={props.req.mode === "save" && window.showSaveFilePicker}>
              <button type="button" class="table-cancel web-path-device" onClick={() => void pickOnDevice()}>Save to this device…</button>
            </Show>
            <button type="button" class="table-cancel" onClick={() => finish(null)}>Cancel</button>
            <button type="submit" class="table-insert">{props.req.mode === "save" ? "Save" : "Choose"}</button>
          </div>
        </form>
      </ModalFrame>
    </div>
  );
}

/** Browsers re-ask for a folder after a restart, and only from a click. */
function ReconnectBar() {
  const [busy, setBusy] = createSignal(false);
  const missing = needsAccess;

  const connect = async () => {
    setBusy(true);
    await reconnectAll();
    setBusy(false);
  };
  return (
    <Show when={missing().length}>
      <div class="web-reconnect" role="status">
        <span>
          {missing().length === 1 ? `${missing()[0].name} needs your permission again.` : `${missing().length} folders need your permission again.`}
        </span>
        <button class="table-insert" disabled={busy()} onClick={() => void connect()}>Reconnect</button>
      </div>
    </Show>
  );
}

export function Overlays() {
  return (
    <>
      <ReconnectBar />
      <Show when={request()} keyed>{(req) => <PathDialog req={req} />}</Show>
    </>
  );
}
