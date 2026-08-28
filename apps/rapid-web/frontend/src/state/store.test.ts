import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from './store';

/**
 * `createConversation` reuses an existing blank rather than stacking a new one.
 *
 * Pressing New Chat twice used to leave a column of identical "New chat" rows
 * that the user then had to delete one at a time.
 */
describe('selectAlias', () => {
  beforeEach(() => {
    useStore.setState({
      selectedByKind: { text: null, image: null, audio: null },
      status: null,
      models: [],
    });
  });

  it('keeps the chat and images selections apart', () => {
    // One shared field meant choosing an image model retargeted the chat,
    // which then reported the image model's start failure as its own.
    useStore.getState().selectAlias('text', 'qwen3-4b');
    useStore.getState().selectAlias('image', 'flux2-klein-4b');

    expect(useStore.getState().selectedByKind.text).toBe('qwen3-4b');
    expect(useStore.getState().selectedByKind.image).toBe('flux2-klein-4b');
  });

  it('adopts a served model as the TEXT selection only', () => {
    useStore.getState().setStatus(
      { state: 'ready', model: 'flux2-klein-4b', port: 1, detail: null, can_switch: true },
      false,
    );

    // A served image model must not become the chat's selection — that is
    // exactly the bug the split exists to prevent.
    expect(useStore.getState().selectedByKind.image).toBeNull();
  });

  it('does not overwrite a text selection the user already made', () => {
    useStore.getState().selectAlias('text', 'qwen3-4b');
    useStore.getState().setStatus(
      { state: 'ready', model: 'llama-8b', port: 1, detail: null, can_switch: true },
      false,
    );

    expect(useStore.getState().selectedByKind.text).toBe('qwen3-4b');
  });

  it('stops guessing text once the catalog names the served kind', () => {
    // A poll every few seconds re-ran the adoption, so an image model kept
    // reappearing in the chat picker right after `setModels` moved it out.
    useStore.getState().setModels([
      {
        alias: 'flux2-klein-4b',
        hf_path: 'Runpod/FLUX.2-klein-4B-mflux-4bit',
        size_bytes: null,
        cached: true,
        kind: 'image',
        loadable: true,
        cached_bytes: null,
        tool_call_parser: null,
        reasoning_parser: null,
        is_text_only: false,
        audio_kind: null,
        family: null,
        image_capability: 'both',
      },
    ]);
    useStore.getState().setStatus(
      { state: 'ready', model: 'flux2-klein-4b', port: 1, detail: null, can_switch: true },
      false,
    );

    expect(useStore.getState().selectedByKind.text).toBeNull();
  });
});

describe('createConversation', () => {
  beforeEach(() => {
    useStore.setState({ conversations: [], activeId: null });
  });

  const count = () => useStore.getState().conversations.length;

  it('creates one when there is nothing to reuse', () => {
    const id = useStore.getState().createConversation();
    expect(count()).toBe(1);
    expect(useStore.getState().activeId).toBe(id);
  });

  it('returns the same blank conversation when pressed repeatedly', () => {
    const first = useStore.getState().createConversation();
    const second = useStore.getState().createConversation();
    const third = useStore.getState().createConversation();

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(count()).toBe(1);
  });

  it('creates a new one once the blank has been used', () => {
    const first = useStore.getState().createConversation();
    useStore.getState().appendNode({ role: 'user', content: 'hi', status: 'complete', parentId: null });

    const second = useStore.getState().createConversation();
    expect(second).not.toBe(first);
    expect(count()).toBe(2);
  });

  it('does not reuse a blank the user deliberately named', () => {
    const first = useStore.getState().createConversation();
    // A renamed blank is one the user made on purpose; silently adopting it
    // would put the next chat under a title meant for something else.
    useStore.getState().updateConversation(first, { title: 'Scratch', hasCustomTitle: true });

    const second = useStore.getState().createConversation();
    expect(second).not.toBe(first);
    expect(count()).toBe(2);
  });

  it('does not reuse an archived blank', () => {
    const first = useStore.getState().createConversation();
    useStore.getState().updateConversation(first, { isArchived: true });

    const second = useStore.getState().createConversation();
    expect(second).not.toBe(first);
    // Archiving is how something is put out of the way; pulling it back is
    // the opposite of what the user asked for.
    expect(count()).toBe(2);
  });
});
