/**
 * The physics: ForceAtlas2 in a web worker, run in bounded bursts, with a
 * noverlap pass every time it comes to rest.
 *
 * Obsidian-style live layout. Instead of computing positions once before
 * first paint, FA2 runs while Sigma renders every frame — the graph visibly
 * unfolds from the packed seed, drifts apart where it's crowded, and settles.
 * `adjustSizes` is what does the de-cluttering: nodes repel by their radius,
 * so big hubs continuously shove neighbours out of their space instead of
 * sitting under them.
 *
 * The simulation is stopped after a few seconds (and re-woken briefly after a
 * drag) rather than left running: FA2 with `adjustSizes` never fully
 * converges, and a permanently-jittering graph reads as broken, not alive.
 */
import type Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import FA2Layout from "graphology-layout-forceatlas2/worker";
import noverlap from "graphology-layout-noverlap";

export type LayoutHandle = {
  /** Run the simulation for a bounded burst, extending if already running. */
  settle: (ms: number) => void;
  /** Stop immediately (used while a node is being dragged). */
  stop: () => void;
  /** Terminate the worker — required on unmount, or it leaks per mount. */
  kill: () => void;
};

export function createLayout(graph: Graph, el: HTMLElement): LayoutHandle {
  const layout = new FA2Layout(graph, {
    settings: {
      ...forceAtlas2.inferSettings(graph),
      barnesHutOptimize: true,
      outboundAttractionDistribution: true, // keeps big hubs from dominating
      /**
       * linLog is OFF for spacing. Logarithmic attraction packs satellites
       * right up against their hub; linear attraction's equilibrium edge
       * length is much longer, so fans open into orbits around the logos
       * automatically.
       */
      linLogMode: false,
      /**
       * Near-zero on purpose. Gravity is a pull toward one global center, and
       * with many disconnected company islands that pull packs them into a
       * featureless ring. This low, the geometry is decided by the edges
       * instead: hub-and-spoke stars, chains through shared people, irregular
       * gaps. Islands still stop drifting because Barnes-Hut repulsion fades
       * with distance; Sigma's auto-rescale keeps the sprawl in view.
       */
      gravity: 0.05,
      /**
       * The spread lever. With primary-employer attraction boosted 2.5×,
       * clusters hold together on their own — so the extra repulsion here
       * spends itself BETWEEN clusters, which is exactly where the empty
       * canvas space should go.
       */
      scalingRatio: 45,
      slowDown: 15, // stronger forces need more damping to stay calm
      adjustSizes: true,
    },
  });

  /**
   * Anti-collision pass, run every time the simulation comes to rest. FA2's
   * `adjustSizes` only discourages overlap while forces are live — whatever
   * residual overlap exists at stop time would freeze in as logos piled over
   * people. Noverlap nudges offenders apart until nothing touches, so the
   * *resting* state is guaranteed clean; motion during the settle may still
   * overlap, which reads as physics rather than clutter.
   *
   * The size conversion is load-bearing: Sigma sizes are *screen pixels*
   * while positions are graph units, and after auto-rescale one pixel is
   * worth `span / canvas` units. Passing raw pixel sizes would under-correct
   * by exactly that factor — worst on the big logo discs, which are the most
   * visible offenders.
   */
  const relaxOverlaps = () => {
    if (graph.order === 0 || el.clientWidth === 0) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    graph.forEachNode((_n, a) => {
      if (a.x < minX) minX = a.x;
      if (a.x > maxX) maxX = a.x;
      if (a.y < minY) minY = a.y;
      if (a.y > maxY) maxY = a.y;
    });
    const unitsPerPx =
      Math.max((maxX - minX) / el.clientWidth, (maxY - minY) / el.clientHeight) || 1;
    noverlap.assign(graph, {
      maxIterations: 200,
      // +2px so nodes rest with a hairline of air, not kissing edges
      inputReducer: (_k, attr) => ({
        ...attr,
        size: ((attr.size ?? 3) + 2) * unitsPerPx,
      }),
      settings: { ratio: 1, margin: 0, speed: 2 },
    });
  };

  let settleTimer: number | null = null;
  const settle = (ms: number) => {
    if (settleTimer !== null) window.clearTimeout(settleTimer);
    if (!layout.isRunning()) layout.start();
    settleTimer = window.setTimeout(() => {
      layout.stop();
      relaxOverlaps();
    }, ms);
  };

  return {
    settle,
    stop: () => layout.stop(),
    kill: () => {
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      layout.kill();
    },
  };
}
