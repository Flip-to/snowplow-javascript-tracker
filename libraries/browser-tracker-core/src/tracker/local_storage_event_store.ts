import { EventStore, EventStorePayload, newInMemoryEventStore } from '@snowplow/tracker-core';
import { LocalStorageEventStoreConfigurationBase } from './types';

export interface LocalStorageEventStoreConfiguration extends LocalStorageEventStoreConfigurationBase {
  /**
   * The unique identifier for the event store
   */
  trackerId: string;
}

export interface LocalStorageEventStore extends EventStore {
  setUseLocalStorage: (localStorage: boolean) => void;
}

export function newLocalStorageEventStore({
  trackerId,
  maxLocalStorageQueueSize = 1000,
  useLocalStorage = true,
}: LocalStorageEventStoreConfiguration): LocalStorageEventStore {
  // KEVIN TILLER
  // Remove the name snowplow from our queue
  const queueName = `ftOutQueue_${trackerId}`;

  function newInMemoryEventStoreFromLocalStorage() {
    if (useLocalStorage) {
      const localStorageQueue = window.localStorage.getItem(queueName);
      const events: EventStorePayload[] = localStorageQueue ? JSON.parse(localStorageQueue) : [];
      return newInMemoryEventStore({ maxSize: maxLocalStorageQueueSize, events });
    } else {
      return newInMemoryEventStore({ maxSize: maxLocalStorageQueueSize });
    }
  }

  const { getAll, getAllPayloads, add, count, iterator, removeHead } = newInMemoryEventStoreFromLocalStorage();

  function sync(): Promise<void> {
    if (useLocalStorage) {
      return getAll().then((events) => {
        window.localStorage.setItem(queueName, JSON.stringify(events));
      });
    } else {
      return Promise.resolve();
    }
  }

  return {
    count,
    add: (payload: EventStorePayload) => {
      add(payload);
      return sync().then(count);
    },
    removeHead: (count: number) => {
      removeHead(count);
      return sync();
    },
    iterator,
    getAll,
    getAllPayloads,
    setUseLocalStorage: (use: boolean) => {
      useLocalStorage = use;
      // KEVIN TILLER
      // If we lost permission to access the local storage, delete the queues.  This prevents duplicate
      // of page views when we have initial access, but lose access before the queue can be purged.
      if (!useLocalStorage) {
        window.localStorage.removeItem(queueName);
      }
    },
  };
}
