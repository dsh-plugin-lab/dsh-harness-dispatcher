import { describe, expect, it } from 'vitest'
import { jobOutcomeOf } from '../src/jobs.ts'

describe('jobOutcomeOf', () => {
  it('reports a finished run as completed, with the sentence the model should read', () => {
    expect(jobOutcomeOf(false, undefined, '3/3 trial(s) recorded')).toEqual({
      status: 'completed',
      result: '3/3 trial(s) recorded',
    })
  })

  it('reports a run stopped by the job as killed, without repeating the caller’s reason', () => {
    // The registry merges the `job_kill` reason into the status line itself. Measured: passing the
    // cancel message through `detail` as well printed the reason twice in one line.
    expect(jobOutcomeOf(true, new Error('stopped'), 'partial')).toEqual({
      status: 'killed',
      result: 'partial',
    })
  })

  it('reports a broken run as failed, with a one-line status', () => {
    // `detail` renders inside `[status: failed, …]`, so a multi-line message there became a paragraph
    // in the status line — measured on a killed run before this was narrowed.
    const outcome = jobOutcomeOf(false, new Error('mount failed\nsecond line'), 'none')
    expect(outcome.status).toBe('failed')
    expect(outcome.detail).toBe('mount failed')
    expect(outcome.result).toBe('none')
  })

  it('keeps a non-Error as its own text rather than stringifying an object', () => {
    expect(jobOutcomeOf(false, 'boom', 'x').detail).toBe('boom')
  })

  it('omits the detail when the failure carries no message at all', () => {
    // An absent message is not an empty status line: `[status: failed, ]` reads like a truncation.
    expect(jobOutcomeOf(false, '', 'x')).toEqual({ status: 'failed', result: 'x' })
  })
})
