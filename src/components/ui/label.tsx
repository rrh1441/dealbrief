'use client'
import React from 'react'

/*  Minimal shim: lets existing imports compile.  */
export function Label(
  props: React.LabelHTMLAttributes<HTMLLabelElement>,
) {
  return <label {...props} />
}