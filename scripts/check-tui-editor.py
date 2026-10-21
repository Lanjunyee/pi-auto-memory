import os, pathlib, tempfile, subprocess, pty, fcntl, termios, struct, select, time, json, shutil, hashlib, re, sys, signal, argparse, codecs

def strip_ansi(text):
    text = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)", "", text)
    text = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]", "", text)
    text = re.sub(r"\x1b[()][A-Za-z0-9]", "", text)
    return text.replace("\r", "")

parser = argparse.ArgumentParser()
parser.add_argument("--cli")
parser.add_argument("--host-root")
parser.add_argument("--extension")
parser.add_argument("--timeout", type=float, default=25.0)
options = parser.parse_args()

repo = pathlib.Path(__file__).resolve().parents[1]
if options.host_root:
    host_root = pathlib.Path(options.host_root).resolve()
    cli = pathlib.Path(options.cli).resolve() if options.cli else host_root / "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
elif options.cli:
    cli = pathlib.Path(options.cli).resolve()
    host_root = cli.parents[4] if len(cli.parents) > 4 else cli.parent
else:
    cli = repo / "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
    host_root = repo
manifest_path = host_root / "node_modules/@earendil-works/pi-coding-agent/package.json"
if not manifest_path.exists():
    manifest_path = cli.parents[2] / "package.json"
host_version = json.loads(manifest_path.read_text(encoding="utf8")).get("version", "unknown")

if os.name != "posix":
    print(json.dumps({"result": "unsupported", "reason": "PTY validation requires POSIX"}, indent=2))
    sys.exit(2)

root = pathlib.Path(tempfile.mkdtemp(prefix="auto-memory-tui-"))
project = root / "project"
agent = root / "agent"
home = root / "home"
for directory in (project, agent, home):
    directory.mkdir()
    directory.chmod(0o700)
identity = "cwd-" + hashlib.sha256(str(project.resolve()).encode()).hexdigest()
memory = agent / "memory" / identity
memory.mkdir(parents=True)
topic = memory / "topic.md"
topic.write_text("original editor text", encoding="utf8")
topic.chmod(0o600)
other = memory / "other.md"
other.write_text("other topic body", encoding="utf8")
other.chmod(0o600)
(memory / "MEMORY.md").write_text("# Memory\n\n- [主题](topic.md) — described\n- [其他](other.md) — described\n", encoding="utf8")
(memory / "MEMORY.md").chmod(0o600)

editor = root / "editor.py"
proof = root / "editor-proof.json"
counter = root / "editor-count.txt"
editor.write_text(
    "import pathlib,sys,json\n"
    f"counter=pathlib.Path({str(counter)!r})\n"
    "count=int(counter.read_text()) if counter.exists() else 0\n"
    "counter.write_text(str(count+1))\n"
    "p=pathlib.Path(sys.argv[1]); original=p.read_text()\n"
    "p.write_text('external editor saved text' if count==0 else 'cancelled draft text')\n"
    f"pathlib.Path({str(proof)!r}).write_text(json.dumps({{'prefill':original,'directoryMode':oct(p.parent.stat().st_mode & 0o777),'call':count+1}}))\n",
    encoding="utf8",
)
node = shutil.which("node")
python = shutil.which("python3")
attempts = root / "network-attempts.jsonl"
guard = root / "network-guard.mjs"
guard.write_text(
    "import { appendFileSync } from 'node:fs';\n"
    f"const log = {json.dumps(str(attempts))};\n"
    "globalThis.fetch = async (input) => {\n"
    "  appendFileSync(log, JSON.stringify({ url: String(input) }) + '\\n');\n"
    "  throw new Error('Network access is forbidden in the PTY validation');\n"
    "};\n",
    encoding="utf8",
)
env = {"PATH": os.environ["PATH"], "HOME": str(home), "TMPDIR": str(root), "PI_CODING_AGENT_DIR": str(agent),
       "PI_OFFLINE": "1", "TERM": "xterm-256color", "EDITOR": f"{python} {editor}", "VISUAL": f"{python} {editor}",
       "LANG": "zh_CN.UTF-8", "LC_ALL": "zh_CN.UTF-8",
       "NODE_OPTIONS": f"--import {guard.as_uri()}"}
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
extension = pathlib.Path(options.extension).resolve() if options.extension else repo / "src/index.ts"
process = subprocess.Popen([node, str(cli), "--offline", "-ne", "-e", str(extension), "-ns", "-np",
                            "--no-themes", "-nc", "--no-mcp", "--no-session"],
                           cwd=project, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
transcript = bytearray()
decoder = codecs.getincrementaldecoder("utf8")(errors="replace")
visible = ""
cursor = 0

def pump(timeout):
    global visible, cursor
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        ready, _, _ = select.select([master], [], [], min(0.1, max(0, end - time.monotonic())))
        if ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                return False
            transcript.extend(data)
            visible += strip_ansi(decoder.decode(data))
            if b"\x1b[6n" in data: os.write(master, b"\x1b[1;1R")
            if b"\x1b]11;?" in data: os.write(master, b"\x1b]11;rgb:0000/0000/0000\x07")
        if process.poll() is not None:
            return False
    return True

def flatten(text):
    return re.sub(r"\s+", "", text)

flat_cursor = 0

def wait_for_optional(needle, timeout=options.timeout):
    global flat_cursor
    wanted = flatten(needle)
    end = time.monotonic() + timeout
    while True:
        flat = flatten(visible)
        index = flat.find(wanted, flat_cursor)
        if index >= 0:
            flat_cursor = index + len(wanted)
            return True
        if time.monotonic() >= end or not pump(0.2):
            break
    flat = flatten(visible)
    index = flat.find(wanted, flat_cursor)
    if index >= 0:
        flat_cursor = index + len(wanted)
        return True
    if os.environ.get("TUI_DEBUG"):
        index = flat.find(wanted)
        print(json.dumps({"debug_needle": needle, "cursor": flat_cursor, "length": len(flat), "found_at": index}))
    return False

def wait_for(needle, timeout=options.timeout):
    if not wait_for_optional(needle, timeout):
        raise AssertionError(f"missing expected text: {needle!r}")

def send(data):
    os.write(master, data)

def command(text, settle=1.2):
    send(text.encode())
    pump(0.3)
    send(b"\r")
    pump(settle)

def stop_host():
    try:
        os.killpg(os.getpgid(process.pid), signal.SIGKILL)
    except OSError:
        pass
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill(); process.wait()
    try:
        os.close(master)
    except OSError:
        pass

steps = []
succeeded = False
closed = False
try:
    assert pump(4), "pi TUI did not start"
    steps.append("start")

    send("/memory\r".encode())
    wait_for("记忆管理")
    send(b"\x1b")
    assert pump(1)
    assert process.poll() is None, "menu cancel exited the host"
    steps.append("menu-cancel")

    send("/memory edit topic.md\r".encode())
    wait_for("记忆编辑")
    pump(0.5)
    send(b"\x07")
    assert pump(2)
    deadline = time.monotonic() + 10
    while not proof.exists() and time.monotonic() < deadline:
        pump(0.2)
    assert proof.exists(), "Ctrl+G did not invoke the external editor"
    metadata = json.loads(proof.read_text(encoding="utf8"))
    assert metadata["prefill"] == "original editor text", metadata
    assert metadata["directoryMode"] == "0o700", metadata
    assert topic.read_text(encoding="utf8") == "original editor text", "formal file changed before submit"
    if os.environ.get("TUI_EXPECT_STALE_TITLE"):
        wait_for("完全不存在的旧标题")
    send(b"\r")
    assert pump(2)
    deadline = time.monotonic() + 10
    while topic.read_text(encoding="utf8") != "external editor saved text" and time.monotonic() < deadline:
        pump(0.2)
    assert topic.read_text(encoding="utf8") == "external editor saved text", "submit did not save through the managed chain"
    steps.append("edit-submit")

    send("/memory edit topic.md\r".encode())
    wait_for("记忆编辑")
    pump(0.5)
    send(b"\x07")
    deadline = time.monotonic() + 10
    while json.loads(proof.read_text(encoding="utf8"))["call"] < 2 and time.monotonic() < deadline:
        pump(0.2)
    send(b"\x1b")
    assert pump(1)
    assert topic.read_text(encoding="utf8") == "external editor saved text", "cancel changed the formal file"
    deadline = time.monotonic() + 10
    while list(agent.glob(".auto-memory-edit-*")) and time.monotonic() < deadline:
        pump(0.2)
    assert not list(agent.glob(".auto-memory-edit-*")), "extension draft was not cleaned"
    steps.append("edit-cancel")

    send("/memory check topic.md\r".encode())
    wait_for("记忆关联检查")
    wait_for("索引入口")
    steps.append("check")

    send("/memory project status\r".encode())
    wait_for("记忆项目设置")
    send("/memory project off\r".encode())
    wait_for("当前项目已禁用")
    send("/memory project inherit\r".encode())
    wait_for("恢复继承全局开关")
    steps.append("project-settings")

    send("/memory review other.md\r".encode())
    wait_for("记忆审阅：other.md")
    pump(0.5)
    send(b"\x1b")
    assert pump(1)
    assert other.read_text(encoding="utf8") == "other topic body", "review changed the formal file"
    steps.append("review-cancel")

    send("/memory delete topic.md\r".encode())
    wait_for("删除一个记忆文件？")
    pump(0.5)
    send(b"\x1b[B")
    pump(0.2)
    send(b"\r")
    pump(1.5)
    assert topic.exists(), "rejected confirmation deleted the file"
    send("/memory delete topic.md\r".encode())
    wait_for("删除一个记忆文件？")
    pump(0.5)
    send(b"\r")
    pump(1.5)
    deadline = time.monotonic() + 10
    while topic.exists() and time.monotonic() < deadline:
        pump(0.2)
    assert not topic.exists(), "confirmed delete did not remove the target"
    assert other.exists(), "delete removed a file other than the selected target"
    steps.append("delete-confirm")

    doctor_boundary = len(visible)
    send("/memory doctor\r".encode())
    wait_for("记忆 doctor")
    wait_for("[ok] runtime.node")
    assert len(visible) > doctor_boundary
    steps.append("doctor")

    stop_host()
    closed = True
    networkAttempts = len(attempts.read_text(encoding="utf8").splitlines()) if attempts.exists() else 0
    assert networkAttempts == 0, f"PTY validation attempted {networkAttempts} forbidden network request(s)"
    shutil.rmtree(root)
    assert not root.exists(), "successful run did not remove its temporary sandbox"
    succeeded = True
    print(json.dumps({
        "result": "pass", "hostVersion": host_version, "cli": str(cli), "extension": str(extension), "node": node, "platform": sys.platform,
        "steps": steps, "externalShortcut": "Ctrl+G", "prefill": "pass", "privateHostDirectory": "0700",
        "noFormalWriteBeforeSubmit": "pass", "managedSubmit": "pass", "cancel": "pass", "draftCleanup": "pass",
        "modelTasksSubmitted": False, "authenticationConfigured": False, "offline": "PI_OFFLINE=1",
        "networkAttempts": networkAttempts, "cleanup": "temporary sandbox removed after the run",
    }, ensure_ascii=False, indent=2))
except Exception:
    (root / "tui-transcript.bin").write_bytes(transcript)
    print(json.dumps({"result": "failed", "hostVersion": host_version, "steps": steps,
                      "failureTranscript": str(root / "tui-transcript.bin")}, ensure_ascii=False))
    raise
finally:
    if not closed:
        stop_host()
    if succeeded:
        shutil.rmtree(root, ignore_errors=True)
