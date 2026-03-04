import { Observable, Subject } from "rxjs";
import { shareReplay } from "rxjs/operators";

export interface BroadcastBus<T> {
  publish(payload: T): void;
  stream(): Observable<T>;
  shutdown(): void;
}

export function createBroadcastBus<T>(buffer = 1): BroadcastBus<T> {
  const subject = new Subject<T>();
  const shared = subject.pipe(shareReplay({ bufferSize: buffer, refCount: true }));

  return {
    publish: (payload: T) => subject.next(payload),
    stream: () => shared,
    shutdown: () => subject.complete(),
  };
}
