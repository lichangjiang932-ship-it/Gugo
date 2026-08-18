import {
  PYTHON_INLINE_MUTATION,
  PYTHON_PATH_OPEN_MUTATION,
  PYTHON_PRINT_FILE_MUTATION,
} from './constants.js'

export function hasInlinePythonMutation(code) {
  return PYTHON_INLINE_MUTATION.test(code)
    || PYTHON_PATH_OPEN_MUTATION.test(code)
    || PYTHON_PRINT_FILE_MUTATION.test(code)
}
