'use client'

import { useState, useEffect, useRef, useCallback, useId } from 'react'
import { Play, Square } from 'lucide-react'
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { SearchInput } from '@open-mercato/ui/primitives/search-input'
import { SimpleTooltip } from '@open-mercato/ui/primitives/tooltip'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { ProjectColorDot } from './ProjectColorDot'
import { useActiveTimesheetTimer } from './useActiveTimesheetTimer'
import { useTimesheetPreference } from './useTimesheetPreference'
import { resolveSeedProjectId } from './resolveSeedProjectId'
import { startTimerEntry } from './startTimer'
import { resolveTimerActionError } from './timerErrors'
import { createLogger } from '@open-mercato/shared/lib/logger'

const logger = createLogger('staff')

type ProjectOption = {
  id: string
  name: string
  code: string | null
  color?: string | null
}

type TimerBarProps = {
  projects: ProjectOption[]
  staffMemberId: string | null
  onTimerStopped: () => void
  /** Ids of the projects the member has opted into their grid (`show_in_grid`). */
  visibleProjectIds?: string[]
}

const TIMER_MUTATION_CONTEXT_ID = 'staff-timesheets-timer-bar'

type TimerMutationContext = {
  formId: string
  resourceKind: string
  resourceId: string
  staffMemberId: string | null
  action: 'timer-create' | 'timer-start' | 'timer-stop' | 'timer-notes'
  retryLastMutation: () => Promise<boolean>
}

function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function getToday(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function TimerBar({
  projects,
  staffMemberId,
  onTimerStopped,
  visibleProjectIds,
}: TimerBarProps) {
  const t = useT()
  const { runMutation, retryLastMutation } = useGuardedMutation<TimerMutationContext>({
    contextId: TIMER_MUTATION_CONTEXT_ID,
    blockedMessage: t('ui.forms.flash.saveBlocked', 'Save blocked by validation'),
  })

  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [description, setDescription] = useState('')
  const [persistedDescription, setPersistedDescription] = useState('')
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [isStarting, setIsStarting] = useState(false)
  const [isStopping, setIsStopping] = useState(false)
  const [isSavingDescription, setIsSavingDescription] = useState(false)
  const [showProjectDropdown, setShowProjectDropdown] = useState(false)
  const [projectFilter, setProjectFilter] = useState('')

  const dropdownRef = useRef<HTMLDivElement>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const hasSeededRef = useRef(false)
  const activeTimer = useActiveTimesheetTimer({ staffMemberId })
  const preference = useTimesheetPreference(staffMemberId)

  const activeEntryId = activeTimer.entryId
  const activeProjectId = activeTimer.projectId
  const isRunning = activeTimer.running

  const activeProject = projects.find((p) => p.id === activeProjectId)
  const activeProjectName = activeProject?.name ?? activeTimer.projectName
  const activeProjectColor = activeProject?.color ?? activeTimer.projectColor
  const selectedProject = projects.find((p) => p.id === selectedProjectId)

  const startHintId = useId()
  const startDisabledReason = selectedProjectId
    ? null
    : projects.length === 0
      ? t(
          'staff.timesheets.my.timer.startDisabledNoProjects',
          'No projects assigned yet — ask an admin to assign you to one',
        )
      : t('staff.timesheets.my.timer.startDisabledNoProject', 'Pick a project to start the timer')

  const filteredProjects = projects.filter((p) =>
    p.name.toLowerCase().includes(projectFilter.toLowerCase()),
  )

  const startElapsedCounter = useCallback((startedAt: string) => {
    const startTime = new Date(startedAt).getTime()
    const calcElapsed = () => Math.max(0, Math.floor((Date.now() - startTime) / 1000))
    setElapsedSeconds(calcElapsed())

    if (intervalRef.current) clearInterval(intervalRef.current)
    intervalRef.current = setInterval(() => {
      setElapsedSeconds(calcElapsed())
    }, 1000)
  }, [])

  const stopElapsedCounter = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    setElapsedSeconds(0)
  }, [])

  useEffect(() => {
    if (activeTimer.running && activeTimer.startedAt) {
      startElapsedCounter(activeTimer.startedAt)
      if (activeTimer.notes != null) {
        setDescription(activeTimer.notes)
        setPersistedDescription(activeTimer.notes)
      }
      return
    }
    stopElapsedCounter()
  }, [activeTimer.running, activeTimer.startedAt, activeTimer.notes, startElapsedCounter, stopElapsedCounter])

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [])

  // Seed the picker once the inputs it ranks are actually known.
  //
  // Both guards matter. Seeding before the active-timer lookup settles would apply
  // a lower rung and then be overtaken by the running timer, so the picker would
  // visibly flip or stick on the wrong project — the exact confusion #3750 reports.
  // And seeding only while the selection is still null means a deliberate pick
  // always beats a late-arriving fetch.
  useEffect(() => {
    if (hasSeededRef.current) return
    if (!staffMemberId) return
    if (activeTimer.isLoading || preference.isLoading) return
    if (projects.length === 0) return
    if (selectedProjectId !== null) return

    hasSeededRef.current = true
    const seeded = resolveSeedProjectId({
      runningProjectId: activeTimer.projectId,
      lastProjectId: preference.lastProjectId,
      visibleProjectIds: visibleProjectIds ?? [],
      assignedProjectIds: projects.map((p) => p.id),
    })
    if (seeded) setSelectedProjectId(seeded)
  }, [
    staffMemberId,
    activeTimer.isLoading,
    activeTimer.projectId,
    preference.isLoading,
    preference.lastProjectId,
    projects,
    selectedProjectId,
    visibleProjectIds,
  ])

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setShowProjectDropdown(false)
        setProjectFilter('')
      }
    }

    if (showProjectDropdown) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showProjectDropdown])

  const handleStart = async () => {
    if (!selectedProjectId || !staffMemberId) return

    setIsStarting(true)
    try {
      const today = getToday()
      const startPayload = {
        staffMemberId,
        timeProjectId: selectedProjectId,
        date: today,
        notes: description || null,
      }
      await runMutation({
        operation: () => startTimerEntry(startPayload),
        context: {
          formId: TIMER_MUTATION_CONTEXT_ID,
          resourceKind: 'staff.timesheets.time_entry',
          resourceId: staffMemberId,
          staffMemberId,
          action: 'timer-start',
          retryLastMutation,
        },
        mutationPayload: startPayload,
      })

      setPersistedDescription(description)

      // Remember the project on a *successful start* only — not on selection, so an
      // idle mis-click in the dropdown never becomes tomorrow's default. The timer
      // is already running at this point, so a failed write must not surface an
      // error or fail the start; the next successful start corrects the memory.
      void preference.save(selectedProjectId).catch((prefErr: unknown) => {
        logger.warn('staff.timesheets.timer.preferenceWriteFailed', { err: prefErr })
      })

      await activeTimer.refresh()
    } catch (err) {
      flash(
        resolveTimerActionError(err, t('staff.timesheets.my.timer.startError', 'Failed to start timer')),
        'error',
      )
    } finally {
      setIsStarting(false)
    }
  }

  const saveRunningDescription = useCallback(async () => {
    if (!activeEntryId) return true

    const normalizedDescription = description.trim()
    const normalizedPersistedDescription = persistedDescription.trim()
    if (normalizedDescription === normalizedPersistedDescription) return true

    setIsSavingDescription(true)
    try {
      const notesPayload = { id: activeEntryId, notes: normalizedDescription || null }
      await runMutation({
        operation: () =>
          apiCallOrThrow('/api/staff/timesheets/time-entries', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(notesPayload),
          }),
        context: {
          formId: TIMER_MUTATION_CONTEXT_ID,
          resourceKind: 'staff.timesheets.time_entry',
          resourceId: activeEntryId,
          staffMemberId,
          action: 'timer-notes',
          retryLastMutation,
        },
        mutationPayload: notesPayload,
      })
      setPersistedDescription(normalizedDescription)
      return true
    } catch (err) {
      flash(
        resolveTimerActionError(err, t('staff.timesheets.my.errors.save', 'Failed to save timesheets.')),
        'error',
      )
      return false
    } finally {
      setIsSavingDescription(false)
    }
  }, [activeEntryId, description, persistedDescription, runMutation, staffMemberId, retryLastMutation, t])

  const handleStop = async () => {
    if (!activeEntryId) return

    setIsStopping(true)
    try {
      await saveRunningDescription()
      const stopPayload = {
        id: activeEntryId,
        action: 'timer-stop',
        staffMemberId,
      }
      await runMutation({
        operation: () =>
          apiCallOrThrow(
            `/api/staff/timesheets/time-entries/${activeEntryId}/timer-stop`,
            { method: 'POST' },
          ),
        context: {
          formId: TIMER_MUTATION_CONTEXT_ID,
          resourceKind: 'staff.timesheets.time_entry',
          resourceId: activeEntryId,
          staffMemberId,
          action: 'timer-stop',
          retryLastMutation,
        },
        mutationPayload: stopPayload,
      })

      setPersistedDescription(description.trim())
      await activeTimer.refresh()
      onTimerStopped()
    } catch (err) {
      flash(
        resolveTimerActionError(err, t('staff.timesheets.my.timer.stopError', 'Failed to stop timer')),
        'error',
      )
    } finally {
      setIsStopping(false)
    }
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card p-3 mb-4">
      <input
        type="text"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        disabled={isSavingDescription}
        onBlur={() => {
          if (isRunning) {
            void saveRunningDescription()
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && isRunning) {
            event.preventDefault()
            void saveRunningDescription()
          }
        }}
        placeholder={t(
          'staff.timesheets.my.timer.placeholder',
          'What are you working on?',
        )}
        className="flex-1 bg-transparent border-0 outline-none text-sm placeholder:text-muted-foreground"
      />

      <div className="relative" ref={dropdownRef}>
        {isRunning ? (
          activeProjectName ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded border bg-muted">
              <ProjectColorDot colorKey={activeProjectColor} projectName={activeProjectName} size="xs" />
              {activeProjectName}
            </span>
          ) : null
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              // h-8, matching the Start/Stop `IconButton size="default"` (size-8)
              // beside it. `Button` and `IconButton` do NOT share a size scale:
              // IconButton `default` is 32px and `lg` is 36px, so `Button
              // size="default"` (36px) would break the row, not fix it.
              // See `.ai/ui-components.md` § primitive pairing.
              size="sm"
              onClick={() => {
                setShowProjectDropdown(!showProjectDropdown)
                setProjectFilter('')
              }}
              className="text-xs font-medium"
            >
              {selectedProject
                ? (<><ProjectColorDot colorKey={selectedProject.color} projectName={selectedProject.name} size="xs" /><span className="ml-1">{selectedProject.name}</span></>)
                : t('staff.timesheets.my.timer.selectProject', 'Project')}
            </Button>

            {showProjectDropdown && (
              <div className="absolute right-0 top-full mt-1 z-dropdown min-w-52 rounded-md border bg-popover p-1 shadow-lg">
                <SearchInput
                  size="sm"
                  value={projectFilter}
                  onChange={setProjectFilter}
                  placeholder={t(
                    'staff.timesheets.my.timer.searchProject',
                    'Search projects...',
                  )}
                  className="mb-1"
                  autoFocus
                />
                <div className="max-h-52 overflow-y-auto">
                  {filteredProjects.length === 0 ? (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">
                      {t(
                        'staff.timesheets.my.timer.noProjects',
                        'No projects found',
                      )}
                    </div>
                  ) : (
                    filteredProjects.map((project) => (
                      <Button
                        key={project.id}
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="w-full justify-start text-xs h-auto py-1.5"
                        onClick={() => {
                          setSelectedProjectId(project.id)
                          setShowProjectDropdown(false)
                          setProjectFilter('')
                        }}
                      >
                        <ProjectColorDot colorKey={project.color} projectName={project.name} size="xs" />
                        <span className="ml-1">{project.name}</span>
                        {project.code ? (
                          <span className="ml-1 text-muted-foreground">
                            ({project.code})
                          </span>
                        ) : null}
                      </Button>
                    ))
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <span className="font-mono text-sm tabular-nums min-w-16 text-right">
        {formatElapsed(elapsedSeconds)}
      </span>

      {isRunning ? (
        <IconButton
          type="button"
          variant="destructive"
          size="default"
          onClick={handleStop}
          disabled={isStopping}
          aria-label={t('staff.timesheets.my.timer.stop', 'Stop timer')}
        >
          <Square className="size-4" />
        </IconButton>
      ) : (
        <>
          <SimpleTooltip content={startDisabledReason} side="top">
            <span className="inline-flex" tabIndex={startDisabledReason ? 0 : undefined}>
              <IconButton
                type="button"
                variant="primary"
                size="default"
                onClick={handleStart}
                disabled={isStarting || !selectedProjectId}
                aria-label={t('staff.timesheets.my.timer.start', 'Start timer')}
                aria-describedby={startDisabledReason ? startHintId : undefined}
              >
                <Play className="size-4" />
              </IconButton>
            </span>
          </SimpleTooltip>
          {startDisabledReason ? (
            <span id={startHintId} className="sr-only">
              {startDisabledReason}
            </span>
          ) : null}
        </>
      )}
    </div>
  )
}
