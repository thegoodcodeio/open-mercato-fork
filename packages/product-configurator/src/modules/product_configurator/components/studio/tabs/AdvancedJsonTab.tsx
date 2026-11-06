"use client"

import * as React from 'react'
import { DefinitionJsonEditor } from '../DefinitionJsonEditor'
import type { StudioTabProps } from './types'

export function AdvancedJsonTab({ model, definition, onChange, readOnly, onPendingJsonChange }: StudioTabProps) {
  return (
    <DefinitionJsonEditor
      source={definition}
      currencyCode={model.currencyCode}
      readOnly={readOnly}
      onApply={(next) => onChange(() => next)}
      onPendingChange={onPendingJsonChange}
    />
  )
}
