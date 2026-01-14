/**
 * Function Wrapper - Utilities for instrumenting functions with logging
 * Provides HOCs and hooks for automatic function call logging
 */

import { useCallback, useMemo, useRef } from 'react'
import { logFunction, logError } from './comprehensiveLogger'

/**
 * Wrap a function to automatically log calls
 * @param {Function} fn - Function to wrap
 * @param {string} component - Component name
 * @param {string} fnName - Function name
 * @param {object} options - Configuration options
 * @returns {Function} Wrapped function
 */
export function wrapFunction(fn, component, fnName, options = {}) {
  const {
    logArgs = true,
    logResult = false,
    logTiming = true,
    isHandler = false,
    isAsync = false
  } = options

  // Determine function type for logging
  const fnType = isHandler ? 'handler_call' : 'function_call'

  function wrapped(...args) {
    const startTime = logTiming ? performance.now() : null

    // Build args payload
    const argsPayload = logArgs ? sanitizeArgs(args) : { count: args.length }

    // Log function entry
    logFunction(fnType, component, fnName, {
      phase: 'entry',
      args: argsPayload
    })

    try {
      const result = fn.apply(this, args)

      // Handle async functions
      if (result instanceof Promise) {
        return result
          .then(res => {
            logFunctionSuccess(component, fnName, fnType, startTime, res, logResult)
            return res
          })
          .catch(err => {
            logFunctionError(component, fnName, err, startTime)
            throw err
          })
      }

      // Sync function success
      logFunctionSuccess(component, fnName, fnType, startTime, result, logResult)
      return result

    } catch (err) {
      logFunctionError(component, fnName, err, startTime)
      throw err
    }
  }

  // Preserve function name
  Object.defineProperty(wrapped, 'name', { value: `wrapped_${fnName}` })

  return wrapped
}

/**
 * Log successful function completion
 */
function logFunctionSuccess(component, fnName, fnType, startTime, result, logResult) {
  const duration = startTime ? Math.round(performance.now() - startTime) : null

  logFunction(fnType, component, fnName, {
    phase: 'exit',
    success: true,
    duration,
    result: logResult ? sanitizeResult(result) : undefined
  })
}

/**
 * Log function error
 */
function logFunctionError(component, fnName, error, startTime) {
  const duration = startTime ? Math.round(performance.now() - startTime) : null

  logError(component, fnName, error, {
    phase: 'exit',
    success: false,
    duration
  })
}

/**
 * Sanitize function arguments for logging
 */
function sanitizeArgs(args) {
  if (!args || args.length === 0) return []

  return args.map((arg, index) => {
    // Don't log event objects in detail (too large)
    if (arg instanceof Event) {
      return { type: 'Event', eventType: arg.type }
    }

    // Don't log React elements
    if (arg && typeof arg === 'object' && arg.$$typeof) {
      return { type: 'ReactElement' }
    }

    // Don't log functions
    if (typeof arg === 'function') {
      return { type: 'Function', name: arg.name || 'anonymous' }
    }

    // Don't log large objects
    if (typeof arg === 'object' && arg !== null) {
      const json = JSON.stringify(arg)
      if (json.length > 500) {
        return { type: 'Object', keys: Object.keys(arg).slice(0, 10), truncated: true }
      }
      return arg
    }

    // Primitives are safe
    return arg
  })
}

/**
 * Sanitize function result for logging
 */
function sanitizeResult(result) {
  if (result === undefined) return undefined
  if (result === null) return null

  // Don't log React elements
  if (result && typeof result === 'object' && result.$$typeof) {
    return { type: 'ReactElement' }
  }

  // Don't log functions
  if (typeof result === 'function') {
    return { type: 'Function' }
  }

  // Don't log large objects
  if (typeof result === 'object') {
    const json = JSON.stringify(result)
    if (json.length > 500) {
      return { type: 'Object', truncated: true }
    }
    return result
  }

  return result
}

/**
 * React hook that creates a logged callback (replacement for useCallback)
 * @param {Function} callback - Callback function
 * @param {Array} deps - Dependency array
 * @param {string} component - Component name
 * @param {string} fnName - Function name
 * @param {object} options - Logging options
 * @returns {Function} Memoized and logged callback
 */
export function useLoggingCallback(callback, deps, component, fnName, options = {}) {
  const wrappedCallback = useMemo(() => {
    return wrapFunction(callback, component, fnName, {
      isHandler: true,
      ...options
    })
  }, deps) // eslint-disable-line react-hooks/exhaustive-deps

  return wrappedCallback
}

/**
 * React hook that logs when a callback is invoked
 * Lighter weight than useLoggingCallback - just adds logging without full wrapping
 * @param {Function} callback - Callback function
 * @param {Array} deps - Dependency array
 * @param {string} component - Component name
 * @param {string} fnName - Function name
 * @returns {Function} Memoized callback with logging
 */
export function useLoggedCallback(callback, deps, component, fnName) {
  return useCallback((...args) => {
    logFunction('handler_call', component, fnName, {
      argsCount: args.length
    })
    return callback(...args)
  }, deps) // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * Wrap all methods of an object for logging (useful for utility modules)
 * @param {object} obj - Object with methods to wrap
 * @param {string} moduleName - Module name for logging
 * @param {object} options - Logging options
 * @returns {object} Object with wrapped methods
 */
export function instrumentObject(obj, moduleName, options = {}) {
  const instrumented = {}

  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'function') {
      instrumented[key] = wrapFunction(obj[key], moduleName, key, options)
    } else {
      instrumented[key] = obj[key]
    }
  }

  return instrumented
}

/**
 * Create a logger instance for a specific component
 * @param {string} componentName - Component name
 * @returns {object} Logger methods bound to component
 */
export function createComponentLogger(componentName) {
  return {
    /**
     * Log a handler call
     */
    logHandler: (handlerName, payload = {}) => {
      logFunction('handler_call', componentName, handlerName, payload)
    },

    /**
     * Log a function call
     */
    logFunction: (fnName, payload = {}) => {
      logFunction('function_call', componentName, fnName, payload)
    },

    /**
     * Log a callback execution
     */
    logCallback: (callbackName, payload = {}) => {
      logFunction('callback_call', componentName, callbackName, payload)
    },

    /**
     * Log a hook execution
     */
    logHook: (hookName, payload = {}) => {
      logFunction('hook_call', componentName, hookName, payload)
    },

    /**
     * Log an effect execution
     */
    logEffect: (effectName, payload = {}) => {
      logFunction('effect_call', componentName, effectName, payload)
    },

    /**
     * Log an error
     */
    logError: (context, error, payload = {}) => {
      logError(componentName, context, error, payload)
    },

    /**
     * Wrap a handler for this component
     */
    wrapHandler: (fn, handlerName, options = {}) => {
      return wrapFunction(fn, componentName, handlerName, { isHandler: true, ...options })
    },

    /**
     * Wrap a function for this component
     */
    wrapFunction: (fn, fnName, options = {}) => {
      return wrapFunction(fn, componentName, fnName, options)
    }
  }
}

/**
 * React hook to get a component logger
 * @param {string} componentName - Component name
 * @returns {object} Logger methods bound to component
 */
export function useComponentLogger(componentName) {
  const loggerRef = useRef(null)

  if (!loggerRef.current) {
    loggerRef.current = createComponentLogger(componentName)
  }

  return loggerRef.current
}

/**
 * Higher-order component that provides logging context
 * @param {React.Component} WrappedComponent - Component to wrap
 * @param {string} componentName - Component name for logging
 * @returns {React.Component} Wrapped component with logging
 */
export function withLogging(WrappedComponent, componentName) {
  const displayName = componentName || WrappedComponent.displayName || WrappedComponent.name || 'Component'

  function WithLogging(props) {
    const logger = useComponentLogger(displayName)

    // Log component mount
    useMemo(() => {
      logFunction('lifecycle', displayName, 'mount', {})
    }, [])

    return <WrappedComponent {...props} logger={logger} />
  }

  WithLogging.displayName = `WithLogging(${displayName})`
  return WithLogging
}
