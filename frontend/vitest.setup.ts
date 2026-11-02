class InMemoryStorage implements Storage {
    private readonly store = new Map<string, string>();

    get length(): number {
        return this.store.size;
    }

    clear(): void {
        this.store.clear();
    }

    getItem(key: string): string | null {
        return this.store.get(String(key)) ?? null;
    }

    key(index: number): string | null {
        return Array.from(this.store.keys())[index] ?? null;
    }

    removeItem(key: string): void {
        this.store.delete(String(key));
    }

    setItem(key: string, value: string): void {
        this.store.set(String(key), String(value));
    }
}

if (
    typeof window !== "undefined" &&
    (!window.localStorage || typeof window.localStorage.clear !== "function")
) {
    const storage = new InMemoryStorage();
    Object.defineProperty(window, "localStorage", {
        value: storage,
        configurable: true,
        writable: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
        value: storage,
        configurable: true,
        writable: true,
    });
}

if (typeof globalThis.ResizeObserver === "undefined") {
    class MockResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
    }

    globalThis.ResizeObserver =
        MockResizeObserver as unknown as typeof ResizeObserver;
}
