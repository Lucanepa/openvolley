import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { ServiceBox, TICK_START } from '../components/ServiceBox'
import { SERVICE_NUMBER_DROP_MM, SERVICE_NUMBER_PX } from '../components/Marks'

// The owner (2026-10-24): the tick through the round number ran into the team
// score written in the box; the score sits lower and the tick is shorter from
// its bottom left.
const round = (over: Record<string, unknown> = {}) => ({ position: 0, box: 2, ticked: true, points: 22, circled: false, ...over })
const points = (c: HTMLElement) => c.querySelector('[data-mark="service-points"]') as HTMLElement

describe('a service box', () => {
  afterEach(() => cleanup())

  it('the score at the loss of service sits below the tick', () => {
    const { container } = render(<ServiceBox num={2} round={round()} />)
    expect(container.querySelector('[data-mark="round-tick"]')).not.toBeNull()
    expect(points(container).textContent).toBe('22')
    expect(points(container).style.transform).toBe(`translateY(${SERVICE_NUMBER_DROP_MM}mm)`)
  })

  it('a circled final stays centred in its ring, with a white edge where the tick crosses it', () => {
    const { container } = render(<ServiceBox num={2} round={round({ points: 25, circled: true })} />)
    expect(points(container).style.transform).toBe('')
    expect(points(container).style.textShadow).toContain('#fff')
  })

  it('the lowered score clears the tick and stays inside its 5 mm box', () => {
    const pxToMm = (px: number) => px * 25.4 / 96
    // the tick: a 2.4 mm square from 0.2 mm above the box; its lowest point
    const tickEndMm = -0.2 + 2.4 * (100 - TICK_START) / 100
    expect(tickEndMm).toBeLessThan(1.6) // it started 1.9 mm down (x1 = 12)
    // bold digits are ~0.72 em tall, centred in the box
    const inkHalfMm = pxToMm(SERVICE_NUMBER_PX) * 0.72 / 2
    expect(2.5 - inkHalfMm + SERVICE_NUMBER_DROP_MM).toBeGreaterThan(tickEndMm + 0.1)
    expect(2.5 + inkHalfMm + SERVICE_NUMBER_DROP_MM).toBeLessThan(5 - 0.2)
  })
})
