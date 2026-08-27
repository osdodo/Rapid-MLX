import type { MessageNode } from '@/state/types';

/**
 * Tree arithmetic over a flat node array.
 *
 * A port of apps/rapid-mac/Sources/Rapid/Chat/MessageTree.swift.
 *
 * A conversation persists EVERY branch it has ever grown as one unsorted bag
 * of nodes; the transcript on screen is the single root-to-leaf path derived
 * here. Keeping the maths in one module — rather than spread across the store
 * and the components — is what lets the sibling switcher, the wire body,
 * export and search all agree on what "the conversation" means at any moment.
 *
 * Edges are single-direction (`parentId` only). Everything a `childIds` array
 * would have given us is recomputed by scan instead, which trades a linear
 * pass per query for the guarantee that the two halves of a bidirectional link
 * can never disagree. Transcripts are hundreds of nodes at the very top end
 * and every one of these runs off a user gesture, never per streamed token, so
 * the scan does not show up.
 *
 * EVERY ENTRY POINT IS TOTAL. Cycles, orphans and dangling leaf pointers are
 * absorbed into a sensible answer rather than throwing. A corrupt or
 * hand-edited localStorage blob must degrade to a readable transcript, never
 * to a white screen — and unlike the Mac app's file, this one lives in a
 * store the user can open and edit in a devtools console.
 */

/**
 * Sibling order.
 *
 * `createdAt` is the real signal — branches are grown one at a time by a user
 * gesture — with the id as a tie-break so two nodes stamped inside the same
 * millisecond still order deterministically across reloads. An unstable order
 * would make the `‹ 2/3 ›` index jump around under the user between one
 * session and the next.
 */
export function precedes(a: MessageNode, b: MessageNode): boolean {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt;
  return a.id < b.id;
}

function sorted(nodes: MessageNode[]): MessageNode[] {
  return [...nodes].sort((a, b) => (precedes(a, b) ? -1 : precedes(b, a) ? 1 : 0));
}

/**
 * First occurrence of each id wins; later duplicates are dropped.
 *
 * Duplicate ids can only come from a corrupt or hand-merged store, but they
 * must be resolved ONCE, up front: the path walk's index keeps the first copy
 * while the sibling and subtree scans would count every copy — so navigation
 * and deletion could disagree about what a node even is. Every consumer of a
 * whole tree runs its input through this first.
 */
export function deduplicateById(nodes: MessageNode[]): MessageNode[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    if (seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  });
}

/** Children of `parentId` in sibling order. Pass null for the roots. */
export function children(parentId: string | null, nodes: MessageNode[]): MessageNode[] {
  return sorted(nodes.filter((node) => node.parentId === parentId));
}

/**
 * The sibling group containing `id` — every alternative answer at that point,
 * including `id` itself. A node with no alternatives returns a single-element
 * array, which is the signal the UI uses to hide the switcher entirely rather
 * than render a permanent `‹ 1/1 ›`.
 */
export function siblings(id: string, nodes: MessageNode[]): MessageNode[] {
  const node = nodes.find((candidate) => candidate.id === id);
  if (!node) return [];
  return children(node.parentId, nodes);
}

/**
 * Walk down from `id` and return the leaf that terminates the walk.
 *
 * At each step `preferring` decides which way to go, falling back to the
 * newest child when it has no opinion. That map is what makes returning to a
 * branch land where the user left it: without it a branch carrying a long
 * continuation would always jump to its deepest tip, so a user who stepped
 * back three turns and then looked at a sibling would find their position
 * silently discarded on the way back.
 */
export function deepestLeaf(
  id: string,
  nodes: MessageNode[],
  preferring: Record<string, string> = {},
): string {
  let current = id;
  const seen = new Set<string>([id]);

  for (;;) {
    const options = children(current, nodes);
    if (options.length === 0) break;

    // A remembered choice only counts while it is still a child of this node.
    // A stale entry — branch deleted, store hand-edited — degrades to the
    // newest child rather than stranding the walk.
    const wanted = preferring[current];
    const remembered = wanted ? options.find((option) => option.id === wanted) : undefined;
    const next = remembered ?? options[options.length - 1];
    if (!next) break;

    // A cycle can only come from a corrupt store, but walking one would hang
    // the tab. Bail and treat the current node as the leaf.
    if (seen.has(next.id)) break;
    seen.add(next.id);
    current = next.id;
  }

  return current;
}

/**
 * The leaf to show when a conversation carries no usable `activeLeafId` —
 * either because it predates branching or because the stored pointer no
 * longer resolves.
 *
 * Picks the newest node overall, then resolves downwards, which lands on the
 * tip of the branch most recently worked in and reduces to "the last message"
 * for a linear transcript.
 */
export function defaultLeaf(
  nodes: MessageNode[],
  preferring: Record<string, string> = {},
): string | null {
  if (nodes.length === 0) return null;
  let newest = nodes[0] as MessageNode;
  for (const node of nodes) if (precedes(newest, node)) newest = node;
  return deepestLeaf(newest.id, nodes, preferring);
}

/**
 * The parent -> chosen-child edges of `path`.
 *
 * Recorded every time a path becomes the visible one, so each fork remembers
 * which way the user last went. Only the edges actually on the path are
 * produced; callers MERGE this over what they already hold rather than
 * replacing it, so a branch the user has not visited this session keeps the
 * position it had.
 */
export function choicesAlong(path: MessageNode[]): Record<string, string> {
  const edges: Record<string, string> = {};
  for (const node of path) {
    if (node.parentId === null) continue;
    edges[node.parentId] = node.id;
  }
  return edges;
}

/**
 * The visible transcript: the root-to-leaf path ending at `activeLeafId`,
 * oldest turn first.
 *
 * This is what the user sees, what gets sent to the model, and what export
 * writes — one definition, so those three can never diverge. An unresolvable
 * `activeLeafId` falls back to `defaultLeaf` rather than rendering an empty
 * conversation.
 */
export function activePath(
  nodes: MessageNode[],
  activeLeafId: string | null,
  preferring: Record<string, string> = {},
): MessageNode[] {
  if (nodes.length === 0) return [];

  const index = new Map<string, MessageNode>();
  for (const node of nodes) if (!index.has(node.id)) index.set(node.id, node);

  let leaf = activeLeafId !== null && index.has(activeLeafId) ? activeLeafId : null;
  if (leaf === null) leaf = defaultLeaf(nodes, preferring);
  if (leaf === null) return [];

  const path: MessageNode[] = [];
  const seen = new Set<string>();
  let cursor: string | null = leaf;

  while (cursor !== null) {
    const node: MessageNode | undefined = index.get(cursor);
    if (!node) break;
    // Same cycle guard as deepestLeaf — a corrupt parent chain must not spin.
    if (seen.has(node.id)) break;
    seen.add(node.id);
    path.push(node);
    cursor = node.parentId;
  }

  return path.reverse();
}

/**
 * `id` plus every node beneath it, across every branch.
 *
 * Deleting a turn takes its whole subtree with it. The alternative —
 * re-parenting the orphans onto the deleted node's parent — would splice a
 * prompt and an answer that never belonged together and present the result as
 * real history.
 */
export function subtree(id: string, nodes: MessageNode[]): Set<string> {
  const collected = new Set<string>([id]);
  const frontier: string[] = [id];

  while (frontier.length > 0) {
    const current = frontier.pop() as string;
    for (const child of children(current, nodes)) {
      if (collected.has(child.id)) continue;
      collected.add(child.id);
      frontier.push(child.id);
    }
  }

  return collected;
}

/**
 * Reconnect a transcript that carries no parent links into a degenerate tree —
 * each row parented to the one before it.
 *
 * Runs on load for every conversation written before branching existed. The
 * result renders identically to how it always did, and the first retry on it
 * grows a real branch from there.
 *
 * DELIBERATELY keyed on "NO node has a parent" rather than "SOME node lacks
 * one": in the branching model a user who edits the opening prompt legitimately
 * owns several parentless roots, so a partially-linked tree is already a real
 * tree and must be left alone.
 */
export function repairLegacyChain(nodes: MessageNode[]): MessageNode[] {
  if (nodes.length <= 1) return nodes;
  if (!nodes.every((node) => node.parentId === null)) return nodes;

  return nodes.map((node, index) =>
    index === 0 ? node : { ...node, parentId: nodes[index - 1]?.id ?? null },
  );
}

/**
 * Drop parent links that point at a node which is not present.
 *
 * A dangling parent would strand its whole subtree outside every path, making
 * those turns unreachable in the UI — present in storage, invisible on screen,
 * and counted by nothing. Promoting the orphan to a root keeps the content
 * visible. Applied on load, after the legacy repair.
 */
export function promoteOrphans(nodes: MessageNode[]): MessageNode[] {
  const present = new Set(nodes.map((node) => node.id));
  return nodes.map((node) =>
    node.parentId !== null && !present.has(node.parentId) ? { ...node, parentId: null } : node,
  );
}

/**
 * The node that a `‹ 2/3 ›` switcher on `id` should actually pivot on.
 *
 * Walks back to the first node after the owning user turn, so every row of a
 * logical answer — the answer itself, a tool chip, a follow-up — maps onto the
 * same fork. Without this, the switcher on the second row of a multi-part
 * answer would offer that row's siblings rather than the answer's.
 */
export function branchAnchor(id: string, nodes: MessageNode[]): string | null {
  const index = new Map(nodes.map((node) => [node.id, node] as const));
  let current = index.get(id);
  if (!current) return null;

  const seen = new Set<string>();
  while (current && current.role !== 'user') {
    if (seen.has(current.id)) break;
    seen.add(current.id);
    const parentId = current.parentId;
    if (parentId === null) break;
    const parent = index.get(parentId);
    // The parent is the owning user turn, so `current` is the anchor.
    if (!parent || parent.role === 'user') return current.id;
    current = parent;
  }

  // `id` is itself a user turn, or the walk fell off the top. Either way the
  // node's own sibling group is the right fork.
  return current?.id ?? null;
}

/**
 * How many turns a deletion actually costs.
 *
 * Counts the node plus its whole subtree ACROSS EVERY BRANCH. After a few
 * regenerations some of those turns are not on screen for the user to count,
 * which is exactly why the confirmation has to state the number rather than
 * ask a generic "are you sure".
 */
export function deletionImpact(id: string, nodes: MessageNode[]): number {
  return subtree(id, nodes).size;
}

/**
 * The delete confirmation's title.
 *
 * A pure function so the pluralisation can be pinned by a test rather than
 * discovered in a screenshot.
 */
export function deleteConfirmationTitle(impact: number): string {
  if (impact <= 1) return 'Delete this message?';
  const below = impact - 1;
  return `Delete this message and the ${below} turn${below === 1 ? '' : 's'} below it?`;
}
