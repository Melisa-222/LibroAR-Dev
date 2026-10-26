import * as ecs from '@8thwall/ecs'

// Attach this component to each button. Use the same target for Open and Close.
ecs.registerComponent({
  name: 'Entity Toggle Button',

  schema: {
    // @label Enabled
    enabled: ecs.boolean,
    // Image, model, or parent containing the content to open/close.
    // @label Target Entity
    targetEntity: ecs.eid,
    // On = activate/show. Off = deactivate/close.
    // @label Activate On Click
    activateOnClick: ecs.boolean,
  },

  schemaDefaults: {
    enabled: true,
    activateOnClick: true,
  },

  stateMachine: ({world, eid, schemaAttribute}) => {
    const taps = new Set<number>()
    const maxTapMovement = 0.025

    const hitsButton = (entity: bigint | undefined, ui: boolean) => {
      let belongsToButton = false
      let isUi = false
      for (let current = entity; current; current = world.getParent(current)) {
        // Global listeners must also ignore hidden/disabled parents.
        if (ecs.Hidden.has(world, current) || ecs.Disabled.has(world, current)) return false
        if (current === eid) belongsToButton = true
        if (ecs.Ui.has(world, current)) isUi = true
      }
      return belongsToButton && isUi === ui
    }

    const applyAction = () => {
      const {enabled, targetEntity, activateOnClick} = schemaAttribute.get(eid)
      if (!enabled) return
      if (!targetEntity || !world.allEntities.has(targetEntity)) {
        console.warn('Entity Toggle Button: assign an existing Target Entity in the Inspector.')
        return
      }

      if (activateOnClick) {
        // Support targets initially disabled or hidden in the editor.
        if (ecs.Disabled.has(world, targetEntity)) ecs.Disabled.remove(world, targetEntity)
        if (ecs.Hidden.has(world, targetEntity)) ecs.Hidden.remove(world, targetEntity)
      } else if (!ecs.Disabled.has(world, targetEntity)) {
        // Disable the content so its invisible buttons cannot receive clicks.
        // A Close button may be a child of the target being disabled.
        ecs.Disabled.set(world, targetEntity)
      }
    }

    ecs.defineState('ready')
      .initial()
      .onExit(() => taps.clear())
      .listen(world.events.globalId, ecs.input.UI_CLICK, (event) => {
        if (hitsButton(event.target, true)) applyAction()
      })
      .listen(world.events.globalId, ecs.input.SCREEN_TOUCH_START, ({data}) => {
        taps.delete(data.pointerId)
        // UI has its own click event; do not handle the same gesture twice.
        if (schemaAttribute.get(eid).enabled && hitsButton(data.target, false)) {
          taps.add(data.pointerId)
        }
      })
      .listen(world.events.globalId, ecs.input.SCREEN_TOUCH_MOVE, ({data}) => {
        const distance = Math.hypot(data.position.x - data.start.x, data.position.y - data.start.y)
        if (distance > maxTapMovement) taps.delete(data.pointerId)
      })
      .listen(world.events.globalId, ecs.input.GESTURE_START, ({data}) => {
        if (data.touchCount > 1) taps.clear()
      })
      .listen(world.events.globalId, ecs.input.SCREEN_TOUCH_END, ({data}) => {
        if (!taps.delete(data.pointerId)) return
        if (!hitsButton(data.target, false) || !hitsButton(data.endTarget, false)) return
        const distance = Math.hypot(data.position.x - data.start.x, data.position.y - data.start.y)
        if (distance <= maxTapMovement) applyAction()
      })
  },
})
