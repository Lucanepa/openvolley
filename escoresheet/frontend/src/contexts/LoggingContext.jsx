/**
 * LoggingContext - React Context Provider for comprehensive logging
 * Provides logging functions to all components via useLogging hook
 */

import React, { createContext, useContext, useEffect, useRef, useCallback } from 'react'
import {
  initComprehensiveLogger,
  setGameContext,
  log,
  logUI,
  logFunction,
  logState,
  logNavigation,
  logError,
  shutdownLogger,
  downloadLogs,
  exportLogsAsBlob,
  exportLogsAsNDJSON,
  getLogsSummary,
  getLogCount,
  clearLogs
} from '../utils/comprehensiveLogger'
import {
  installGlobalEventCapture,
  uninstallGlobalEventCapture
} from '../utils/eventCapture'
import { createComponentLogger } from '../utils/functionWrapper'

// Create context
const LoggingContext = createContext(null)

/**
 * LoggingProvider - Wraps app to provide logging capabilities
 * @param {object} props
 * @param {React.ReactNode} props.children - Child components
 * @param {number|null} props.gameNumber - Initial game number
 * @param {string|null} props.matchId - Initial match ID
 * @param {boolean} props.enableEventCapture - Whether to capture global DOM events (default: true)
 */
export function LoggingProvider({
  children,
  gameNumber = null,
  matchId = null,
  enableEventCapture = true
}) {
  const initialized = useRef(false)

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true

    // Initialize comprehensive logger
    initComprehensiveLogger(gameNumber, matchId)

    // Install global event capture
    if (enableEventCapture) {
      installGlobalEventCapture()
    }

    // Log app mount
    logNavigation('component_mount', 'App', 'root_mount', {
      gameNumber,
      matchId,
      enableEventCapture
    })

    return () => {
      logNavigation('component_unmount', 'App', 'root_unmount', {})

      // Cleanup
      if (enableEventCapture) {
        uninstallGlobalEventCapture()
      }
      shutdownLogger()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Update game context when props change
  useEffect(() => {
    if (initialized.current && (gameNumber !== null || matchId !== null)) {
      setGameContext(gameNumber, matchId)
    }
  }, [gameNumber, matchId])

  // Memoized logging functions
  const value = {
    // Core logging functions
    log,
    logUI,
    logFunction,
    logState,
    logNavigation,
    logError,

    // Utility functions
    setGameContext,
    downloadLogs,
    exportLogsAsBlob,
    exportLogsAsNDJSON,
    getLogsSummary,
    getLogCount,
    clearLogs,

    // Component logger factory
    createComponentLogger,

    // Convenience methods for common patterns
    logClick: (component, action, payload = {}) => logUI('click', component, action, payload),
    logInput: (component, action, payload = {}) => logUI('input', component, action, payload),
    logHandler: (component, handlerName, payload = {}) => logFunction('handler_call', component, handlerName, payload),
    logMount: (component) => logNavigation('component_mount', component, 'mount', {}),
    logUnmount: (component) => logNavigation('component_unmount', component, 'unmount', {})
  }

  return (
    <LoggingContext.Provider value={value}>
      {children}
    </LoggingContext.Provider>
  )
}

/**
 * useLogging - Hook to access logging functions
 * @returns {object} Logging context value
 */
export function useLogging() {
  const context = useContext(LoggingContext)

  // Return a no-op logger if context is not available (for testing or standalone usage)
  if (!context) {
    console.warn('[useLogging] LoggingContext not found, returning no-op logger')
    return {
      log: () => {},
      logUI: () => {},
      logFunction: () => {},
      logState: () => {},
      logNavigation: () => {},
      logError: () => {},
      setGameContext: () => {},
      downloadLogs: async () => {},
      exportLogsAsBlob: async () => new Blob([]),
      exportLogsAsNDJSON: async () => '',
      getLogsSummary: async () => ({}),
      getLogCount: async () => 0,
      clearLogs: async () => {},
      createComponentLogger: (name) => ({
        logHandler: () => {},
        logFunction: () => {},
        logCallback: () => {},
        logHook: () => {},
        logEffect: () => {},
        logError: () => {},
        wrapHandler: (fn) => fn,
        wrapFunction: (fn) => fn
      }),
      logClick: () => {},
      logInput: () => {},
      logHandler: () => {},
      logMount: () => {},
      logUnmount: () => {}
    }
  }

  return context
}

/**
 * useComponentLogging - Hook for component-specific logging
 * Returns a logger bound to a specific component name
 * @param {string} componentName - Name of the component
 * @returns {object} Component logger
 */
export function useComponentLogging(componentName) {
  const { createComponentLogger, logNavigation } = useLogging()
  const loggerRef = useRef(null)

  if (!loggerRef.current) {
    loggerRef.current = createComponentLogger(componentName)
  }

  // Log mount/unmount
  useEffect(() => {
    logNavigation('component_mount', componentName, 'mount', {})
    return () => {
      logNavigation('component_unmount', componentName, 'unmount', {})
    }
  }, [componentName, logNavigation])

  return loggerRef.current
}

/**
 * withLogging - HOC that provides logging to class components
 * @param {React.Component} WrappedComponent - Component to wrap
 * @param {string} componentName - Name for logging
 * @returns {React.Component} Wrapped component
 */
export function withLogging(WrappedComponent, componentName) {
  const displayName = componentName || WrappedComponent.displayName || WrappedComponent.name || 'Component'

  function WithLoggingComponent(props) {
    const logger = useComponentLogging(displayName)
    return <WrappedComponent {...props} logger={logger} />
  }

  WithLoggingComponent.displayName = `WithLogging(${displayName})`
  return WithLoggingComponent
}

export default LoggingContext
