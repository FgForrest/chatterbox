import { vi } from "vitest";

interface PendingPlay {
    resolve: () => void;
    reject: (error: DOMException) => void;
}

export class FakeMedia {
    position = 0;
    paused = true;
    ended = false;
    seeking = false;
    readyState = 1;
    duration = 60;
    deferPlay = false;
    autoMetadata = true;
    pending: PendingPlay[] = [];
    loads = 0;

    constructor(readonly element: HTMLMediaElement) {}

    emit(type: string) {
        this.element.dispatchEvent(new Event(type));
    }

    play() {
        this.paused = false;
        this.ended = false;
        this.emit("play");
        const promise = new Promise<void>((resolve, reject) => {
            this.pending.push({ resolve, reject });
        });
        if (!this.deferPlay) queueMicrotask(() => this.finishPlay());
        return promise;
    }

    finishPlay() {
        if (this.paused) return;
        this.emit("playing");
        for (const play of this.pending.splice(0)) play.resolve();
    }

    interrupt(name = "AbortError") {
        this.paused = true;
        for (const play of this.pending.splice(0)) {
            play.reject(new DOMException("Playback interrupted", name));
        }
    }

    pause() {
        const changed = !this.paused;
        this.interrupt();
        if (changed) this.emit("pause");
    }

    load() {
        this.loads++;
        this.interrupt();
        this.position = 0;
        this.readyState = 0;
        this.seeking = false;
        this.emit("emptied");
        if (this.autoMetadata) this.metadata();
    }

    metadata() {
        this.readyState = 1;
        this.emit("loadedmetadata");
    }

    seek(seconds: number) {
        if (this.readyState === 0) {
            throw new DOMException("No metadata", "InvalidStateError");
        }
        this.position = seconds;
        this.seeking = true;
        this.emit("seeking");
        queueMicrotask(() => {
            this.seeking = false;
            this.emit("seeked");
            this.emit("timeupdate");
        });
    }

    advance(seconds: number) {
        this.position = seconds;
        this.emit("timeupdate");
    }
}

/** Install per-element media state with asynchronous play and seek events. */
export function installFakeMedia() {
    const states = new WeakMap<HTMLMediaElement, FakeMedia>();
    const state = (element: HTMLMediaElement) => {
        let media = states.get(element);
        if (!media) {
            media = new FakeMedia(element);
            states.set(element, media);
        }
        return media;
    };
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
        this: HTMLMediaElement,
    ) {
        return state(this).play();
    });
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
        this: HTMLMediaElement,
    ) {
        state(this).pause();
    });
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(function (
        this: HTMLMediaElement,
    ) {
        state(this).load();
    });
    vi.spyOn(
        HTMLMediaElement.prototype,
        "currentTime",
        "get",
    ).mockImplementation(function (this: HTMLMediaElement) {
        return state(this).position;
    });
    vi.spyOn(
        HTMLMediaElement.prototype,
        "currentTime",
        "set",
    ).mockImplementation(function (this: HTMLMediaElement, value) {
        state(this).seek(value);
    });
    for (const property of [
        "paused",
        "ended",
        "seeking",
        "readyState",
        "duration",
    ] as const) {
        vi.spyOn(
            HTMLMediaElement.prototype,
            property,
            "get",
        ).mockImplementation(function (this: HTMLMediaElement) {
            return state(this)[property];
        });
    }
    return state;
}
