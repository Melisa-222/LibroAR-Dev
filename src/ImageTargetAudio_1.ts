import * as ecs from '@8thwall/ecs'

// Add an Audio component to this object and choose its file in the Inspector.
// Put the object under an Image Target, or assign Image Target explicitly.
ecs.registerComponent({
  name: 'Image Target Audio',

  schema: {
    // @label Enabled
    enabled: ecs.boolean,
    // Empty uses the Audio component on this same object.
    // @label Audio Entity
    audioEntity: ecs.eid,
    // Empty finds an Image Target on this object or its nearest ancestor.
    // @label Image Target
    imageTarget: ecs.eid,
    // @label Loop
    loop: ecs.boolean,
    // @label Volume
    // @min 0
    // @max 1
    volume: ecs.f32,
    // Off resumes from the paused position. On restarts on each detection.
    // @label Restart On Found
    restartOnFound: ecs.boolean,
  },

  schemaDefaults: {enabled: true, loop: true, volume: 0.5, restartOnFound: false},

  stateMachine: ({world, eid, schemaAttribute}) => {
    const trackedNames = new Set<string>()
    let audioEntity = 0n
    let targetName = ''
    let audioUrl = ''
    let wasFound = false
    let finished = false
    let seekPending = false
    let lastError = ''

    const pause = (entity: bigint) => {
      if (entity && ecs.Audio.has(world, entity) && !ecs.Audio.get(world, entity).paused) {
        ecs.Audio.mutate(world, entity, audio => { audio.paused = true })
      }
    }

    const findTargetName = () => {
      const {imageTarget} = schemaAttribute.get(eid)
      if (imageTarget) {
        return ecs.ImageTarget.has(world, imageTarget)
          ? ecs.ImageTarget.get(world, imageTarget).name : ''
      }
      for (let current = eid; current; current = world.getParent(current)) {
        if (ecs.ImageTarget.has(world, current)) return ecs.ImageTarget.get(world, current).name
      }
      return ''
    }

    const sync = () => {
      const options = schemaAttribute.get(eid)
      const requestedAudio = options.audioEntity || eid
      const nextAudio = ecs.Audio.has(world, requestedAudio) ? requestedAudio : 0n
      const nextTarget = findTargetName()
      if (audioEntity !== nextAudio || targetName !== nextTarget) {
        pause(audioEntity)
        audioEntity = nextAudio
        targetName = nextTarget
        audioUrl = ''
        wasFound = false
        finished = false
        seekPending = false
        lastError = ''
      }
      if (!audioEntity) return

      const audio = ecs.Audio.get(world, audioEntity)
      if (audio.url !== audioUrl) {
        audioUrl = audio.url
        finished = false
        seekPending = false
        lastError = ''
      }
      const found = !!targetName && trackedNames.has(targetName)
      if (found && !wasFound) {
        seekPending = options.restartOnFound || finished
        finished = false
      }
      wasFound = found
      if (options.loop && finished) {
        finished = false
        seekPending = true
      }
      const shouldPlay = options.enabled && found && !!audioUrl && !finished
      if (seekPending && shouldPlay) {
        try {
          ecs.audio.setCurrentTime(world, audioEntity, 0)
          seekPending = false
        } catch {
          // The Audio component can exist a frame before its media is created.
          // Retry the seek after loading without losing the tracking state.
        }
      }

      const volume = Math.fround(Math.max(0, Math.min(1, options.volume)))
      const paused = !shouldPlay
      if (audio.paused !== paused || audio.loop !== options.loop ||
          audio.volume !== volume || audio.positional) {
        ecs.Audio.mutate(world, audioEntity, cursor => {
          cursor.paused = paused
          cursor.loop = options.loop
          cursor.volume = volume
          // Background music does not change volume with distance to the target.
          cursor.positional = false
        })
      }
    }

    const setTracked = (data: unknown, found: boolean) => {
      if (!data || typeof data !== 'object' || !('name' in data) || typeof data.name !== 'string') return
      if (found) trackedNames.add(data.name)
      else trackedNames.delete(data.name)
      sync()
    }

    ecs.defineState('ready').initial()
      .onEnter(sync)
      .onTick(sync)
      .onExit(() => {
        pause(audioEntity)
        trackedNames.clear()
      })
      .listen(world.events.globalId, ecs.events.REALITY_IMAGE_FOUND, ({data}) => setTracked(data, true))
      // Handles attaching/enabling this component while a target is already tracked.
      .listen(world.events.globalId, ecs.events.REALITY_IMAGE_UPDATED, ({data}) => setTracked(data, true))
      .listen(world.events.globalId, ecs.events.REALITY_IMAGE_LOST, ({data}) => setTracked(data, false))
      .listen(world.events.globalId, ecs.CameraEvents.XR_CAMERA_STOP, () => {
        trackedNames.clear()
        sync()
      })
      .listen(world.events.globalId, ecs.events.AUDIO_END, (event) => {
        if (event.target !== audioEntity || schemaAttribute.get(eid).loop) return
        finished = true
        sync()
      })
      .listen(world.events.globalId, 'audio-error', (event) => {
        if (event.target !== audioEntity) return
        const error = event.data as {error?: {name?: string; message?: string}}
        if (error.error?.name === 'AbortError') return
        const message = error.error?.name === 'NotAllowedError'
          ? 'Tap the screen once to enable audio. Playback still requires the image target.'
          : error.error?.message || 'Could not play the audio file.'
        if (message !== lastError) console.warn(`Image Target Audio: ${message}`)
        lastError = message
        // The engine unlocks/resumes audio on the first screen click. Leave the
        // requested state intact; target loss will still pause only this sound.
      })
  },
})
