import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  CommandAvailability,
  type CommandAvailabilityChecker,
  isCommandAvailable,
  SpawnExecutableResolution,
} from "@t3tools/shared/shell";
import * as ExternalLauncher from "./externalLauncher.ts";

function makeMockDetachedHandle(onUnref: () => void = () => undefined) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.sync(() => {
      onUnref();
      return Effect.void;
    }),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const testLayer = (input: {
  readonly platform: NodeJS.Platform;
  readonly env?: Record<string, string>;
  readonly resolveExecutable?: (command: string) => string | undefined;
  readonly commandAvailability?: CommandAvailabilityChecker;
  readonly onSpawn?: (command: ChildProcess.StandardCommand) => void;
  readonly onUnref?: () => void;
}) => {
  const spawnerLayer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        assert.equal(ChildProcess.isStandardCommand(command), true);
        if (!ChildProcess.isStandardCommand(command)) {
          throw new Error("Expected a standard command");
        }
        input.onSpawn?.(command);
        return makeMockDetachedHandle(input.onUnref);
      }),
    ),
  );

  return Layer.mergeAll(
    ExternalLauncher.layer.pipe(Layer.provide(Layer.merge(NodeServices.layer, spawnerLayer))),
    Layer.succeed(HostProcessPlatform, input.platform),
    Layer.succeed(
      SpawnExecutableResolution,
      (command) => input.resolveExecutable?.(command) ?? command,
    ),
    Layer.succeed(CommandAvailability, input.commandAvailability ?? isCommandAvailable),
    ConfigProvider.layer(ConfigProvider.fromEnv({ env: input.env ?? {} })),
  );
};

it.effect("launches the default browser through the platform command", () => {
  let spawned: ChildProcess.StandardCommand | undefined;
  let didUnref = false;
  return Effect.gen(function* () {
    const launcher = yield* ExternalLauncher.ExternalLauncher;

    yield* launcher.launchBrowser("https://example.com/some path");

    assert.ok(spawned);
    assert.equal(spawned.command, "xdg-open");
    assert.deepEqual(spawned.args, ["https://example.com/some path"]);
    assert.equal(spawned.options.detached, true);
    assert.equal(didUnref, true);
  }).pipe(
    Effect.provide(
      testLayer({
        platform: "linux",
        onSpawn: (command) => {
          spawned = command;
        },
        onUnref: () => {
          didUnref = true;
        },
      }),
    ),
  );
});

it.effect("launches an installed editor with platform-safe arguments", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
    yield* fileSystem.writeFileString(path.join(binDir, "code.CMD"), "@echo off\r\n");

    let spawned: ChildProcess.StandardCommand | undefined;
    yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      yield* launcher.launchEditor({
        editor: "vscode",
        cwd: "C:\\workspace with spaces\\src\\index.ts:12:4",
      });
    }).pipe(
      Effect.provide(
        testLayer({
          platform: "win32",
          env: { PATH: binDir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
          resolveExecutable: (command) =>
            command === "code" ? "C:\\Program Files\\Microsoft VS Code\\bin\\code.CMD" : command,
          onSpawn: (command) => {
            spawned = command;
          },
        }),
      ),
    );

    assert.ok(spawned);
    assert.equal(spawned.command, '^"C:\\Program^ Files\\Microsoft^ VS^ Code\\bin\\code.CMD^"');
    assert.deepEqual(spawned.args, [
      '^"--goto^"',
      '^"C:\\workspace^ with^ spaces\\src\\index.ts:12:4^"',
    ]);
    assert.equal(spawned.options.shell, true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("discovers editors through the service API", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
    yield* fileSystem.writeFileString(path.join(binDir, "code.CMD"), "@echo off\r\n");
    yield* fileSystem.writeFileString(path.join(binDir, "explorer.CMD"), "@echo off\r\n");

    const discovery = yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      return yield* launcher.resolveAvailableEditors();
    }).pipe(
      Effect.provide(
        testLayer({
          platform: "win32",
          env: { PATH: binDir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
        }),
      ),
    );

    assert.equal(discovery.complete, true);
    assert.equal(discovery.editors.includes("vscode"), true);
    assert.equal(discovery.editors.includes("file-manager"), true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps responsive editors when other discovery probes time out", () => {
  const discoveryTimeout = Duration.seconds(3);

  return Effect.gen(function* () {
    const launcher = yield* ExternalLauncher.ExternalLauncher;
    const discoveryFiber = yield* launcher.resolveAvailableEditors().pipe(Effect.forkScoped);

    yield* Effect.yieldNow;
    yield* TestClock.adjust(discoveryTimeout);

    const discovery = yield* Fiber.join(discoveryFiber);
    assert.deepEqual(discovery, {
      editors: ["vscode", "file-manager"],
      complete: false,
    });
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.merge(
        TestClock.layer(),
        testLayer({
          platform: "linux",
          env: { PATH: "/bin" },
          commandAvailability: (command) =>
            command === "code" || command === "xdg-open" ? Effect.succeed(true) : Effect.never,
        }),
      ),
    ),
  );
});

it.effect("preserves the last complete editor list when a cached refresh is incomplete", () => {
  const discoveryTimeout = Duration.seconds(3);
  let incomplete = false;
  let codeChecks = 0;

  return Effect.gen(function* () {
    const launcher = yield* ExternalLauncher.ExternalLauncher;
    const [initialDiscovery, concurrentDiscovery] = yield* Effect.all(
      [launcher.resolveAvailableEditors(), launcher.resolveAvailableEditors()],
      { concurrency: "unbounded" },
    );
    assert.deepEqual(initialDiscovery, {
      editors: ["vscode", "file-manager"],
      complete: true,
    });
    assert.deepEqual(concurrentDiscovery, initialDiscovery);
    assert.equal(codeChecks, 1);

    const cachedDiscovery = yield* launcher.resolveAvailableEditors();
    assert.deepEqual(cachedDiscovery, initialDiscovery);
    assert.equal(codeChecks, 1);

    incomplete = true;
    yield* TestClock.adjust(Duration.minutes(1));

    const refreshFiber = yield* launcher.resolveAvailableEditors().pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* TestClock.adjust(discoveryTimeout);

    const refreshedDiscovery = yield* Fiber.join(refreshFiber);
    assert.deepEqual(refreshedDiscovery, {
      editors: initialDiscovery.editors,
      complete: false,
    });
    assert.equal(codeChecks, 2);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.merge(
        TestClock.layer(),
        testLayer({
          platform: "linux",
          env: { PATH: "/bin" },
          commandAvailability: (command) => {
            if (command === "code") {
              codeChecks += 1;
            }
            if (command === "code" || command === "xdg-open") {
              return Effect.succeed(true);
            }
            return incomplete ? Effect.never : Effect.succeed(false);
          },
        }),
      ),
    ),
  );
});

it.effect("does not cache an incomplete first discovery", () => {
  const discoveryTimeout = Duration.seconds(3);
  let stalled = true;
  let codeChecks = 0;

  return Effect.gen(function* () {
    const launcher = yield* ExternalLauncher.ExternalLauncher;
    const initialFiber = yield* launcher.resolveAvailableEditors().pipe(Effect.forkScoped);

    yield* Effect.yieldNow;
    yield* TestClock.adjust(discoveryTimeout);

    assert.deepEqual(yield* Fiber.join(initialFiber), {
      editors: [],
      complete: false,
    });

    stalled = false;
    const retryDiscovery = yield* launcher.resolveAvailableEditors();
    assert.deepEqual(retryDiscovery, {
      editors: ["vscode", "file-manager"],
      complete: true,
    });
    assert.equal(codeChecks, 2);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.merge(
        TestClock.layer(),
        testLayer({
          platform: "linux",
          env: { PATH: "/bin" },
          commandAvailability: (command) => {
            if (command === "code") {
              codeChecks += 1;
            }
            return stalled
              ? Effect.never
              : Effect.succeed(command === "code" || command === "xdg-open");
          },
        }),
      ),
    ),
  );
});

it.effect("allows editor discovery to retry after a shared lookup defects", () => {
  let shouldDefect = true;
  let codeChecks = 0;

  return Effect.gen(function* () {
    const launcher = yield* ExternalLauncher.ExternalLauncher;
    const failedDiscovery = yield* launcher.resolveAvailableEditors().pipe(Effect.exit);

    assert.equal(Exit.isFailure(failedDiscovery), true);

    shouldDefect = false;
    const retryDiscovery = yield* launcher.resolveAvailableEditors();

    assert.deepEqual(retryDiscovery, {
      editors: ["vscode", "file-manager"],
      complete: true,
    });
    assert.equal(codeChecks, 2);
  }).pipe(
    Effect.provide(
      testLayer({
        platform: "linux",
        env: { PATH: "/bin" },
        commandAvailability: (command) => {
          if (command === "code") {
            codeChecks += 1;
            if (shouldDefect) {
              return Effect.die("discovery defect");
            }
          }
          return Effect.succeed(command === "code" || command === "xdg-open");
        },
      }),
    ),
  );
});

it.effect("rejects unknown editors through the service API", () =>
  Effect.gen(function* () {
    const launcher = yield* ExternalLauncher.ExternalLauncher;
    const error = yield* launcher
      .launchEditor({ editor: "missing-editor" as never, cwd: "/tmp/workspace" })
      .pipe(Effect.flip);
    assert.instanceOf(error, ExternalLauncher.ExternalLauncherUnknownEditorError);
    assert.equal(error.editor, "missing-editor");
    assert.equal(error.message, "Unknown editor: missing-editor");
  }).pipe(Effect.provide(testLayer({ platform: "linux", env: { PATH: "" } }))),
);
