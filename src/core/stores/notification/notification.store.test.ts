import { beforeEach, describe, expect, it } from 'vitest';
import { useNotificationStore } from './notification.store';

describe('NotificationStore', () => {
  beforeEach(() => {
    useNotificationStore.getState().reset();
  });

  it('initializes with default values', () => {
    const state = useNotificationStore.getState();
    expect(state.lastRead).toBe(0);
    expect(state.unread).toBe(0);
  });

  it('sets and gets lastRead timestamp', () => {
    const store = useNotificationStore.getState();
    const timestamp = Date.now();

    store.setLastRead(timestamp);
    expect(store.selectLastRead()).toBe(timestamp);
  });

  it('sets and gets unread count', () => {
    const store = useNotificationStore.getState();

    store.setUnread(5);
    expect(store.selectUnread()).toBe(5);
  });

  it('prevents negative unread count', () => {
    const store = useNotificationStore.getState();

    store.setUnread(-5);
    expect(store.selectUnread()).toBe(0);
  });

  it('sets and gets marketplace unread count', () => {
    const store = useNotificationStore.getState();

    store.setMarketplaceUnread(3);
    expect(store.selectMarketplaceUnread()).toBe(3);
  });

  it('prevents negative marketplace unread count', () => {
    const store = useNotificationStore.getState();

    store.setMarketplaceUnread(-3);
    expect(store.selectMarketplaceUnread()).toBe(0);
  });

  it('sums social and marketplace unread into the badge total without double-counting', () => {
    const store = useNotificationStore.getState();

    store.setUnread(5);
    store.setMarketplaceUnread(3);

    expect(store.selectTotalUnread()).toBe(8);
    // Each source only moves its own counter, so one poll can never clobber
    // or re-add the other's contribution.
    store.setUnread(0);
    expect(store.selectTotalUnread()).toBe(3);
    store.setMarketplaceUnread(0);
    expect(store.selectTotalUnread()).toBe(0);
  });

  it('resets to initial state', () => {
    const store = useNotificationStore.getState();

    store.setLastRead(123456);
    store.setUnread(5);
    store.setMarketplaceUnread(3);
    store.reset();

    expect(store.selectLastRead()).toBe(0);
    expect(store.selectUnread()).toBe(0);
    expect(store.selectMarketplaceUnread()).toBe(0);
    expect(store.selectTotalUnread()).toBe(0);
  });
});
