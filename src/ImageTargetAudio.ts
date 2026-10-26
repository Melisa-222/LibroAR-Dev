import * as ecs from '@8thwall/ecs'

ecs.registerComponent({
  name: 'Image Target Audio',

  // Attach to the entity with Image Target. Assign its audio child below.
  schema: {
    // Turning this off pauses the assigned audio.
    // @label Enabled
    enabled: ecs.boolean,
    // Select the child entity that owns the configured Audio component.
    // @label Audio Entity
    audioEntity: ecs.eid,
  },

  schemaDefaults: {
    enabled: true,
  },

  stateMachine: ({world, eid, schemaAttribute}) => {
    const visibleTargets = new Set<string>()
    let boundAudio = 0n
    const targetName = (data: unknown): string | undefined => {
      if (!data || typeof data !== 'object' || !('name' in data)) return undefined
      return typeof data.name === 'string' ? data.name : undefined
    }

    const setPaused = (target: bigint, paused: boolean) => {
      if (!target || !ecs.Audio.has(world, target)) return
      if (ecs.Audio.get(world, target).paused === paused) return
      // Preserve the asset, volume, loop setting and playback position.
      ecs.Audio.mutate(world, target, (audio) => {
        audio.paused = paused
      })
    }

    const sync = () => {
      const {enabled, audioEntity} = schemaAttribute.get(eid)
      if (boundAudio !== audioEntity) {
        setPaused(boundAudio, true)
        boundAudio = audioEntity
      }
      const name = ecs.ImageTarget.has(world, eid)
        ? ecs.ImageTarget.get(world, eid).name
        : ''
      setPaused(boundAudio, !enabled || !name || !visibleTargets.has(name))
    }

    ecs.defineState('tracking').initial()
      .onEnter(sync)
      // Also handles Audio being added after this controller.
      .onTick(sync)
      .onExit(() => {
        visibleTargets.clear()
        setPaused(boundAudio, true)
      })
      .listen(world.events.globalId, ecs.events.REALITY_IMAGE_FOUND, ({data}) => {
        const name = targetName(data)
        if (name === undefined) return
        visibleTargets.add(name)
        sync()
      })
      .listen(world.events.globalId, ecs.events.REALITY_IMAGE_LOST, ({data}) => {
        const name = targetName(data)
        if (name === undefined) return
        visibleTargets.delete(name)
        sync()
      })
  },
})
