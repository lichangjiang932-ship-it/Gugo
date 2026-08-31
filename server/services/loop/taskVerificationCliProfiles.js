export const NON_VERDICT_OR_MUTATING_ARGUMENT = /(?:^|\s)(?:--if-present|--help|-h|--version|--collect-only|--co|--list|--list-tests|--listtests|--show-config|--showconfig|--show-files|--show-settings|--setup-only|--fixtures(?:-per-test)?|--clear-cache|--clearcache|--pass-with-no-tests|--passwithnotests|--no-run|--print-config|--env-info|--dry-run|--fix(?:-only)?|--write|--install-types|--update(?:snapshot)?|--bless|--accept|--cache(?:-clear|-location)?|--add-noqa|--coverage(?:directory)?|--output(?:file)?|-o|--junitxml|--cov-report|--basetemp|--test-reporter-destination|--results-directory|--logger|--log-file)(?:[=\s]|$)|(?:^|\s)-u(?:\s|$)|(?:^|\s)-D(?:skipTests|maven\.test\.skip)(?:=true)?(?:\s|$)|(?:^|\s)(?:-x|--exclude-task)\s+test(?:\s|$)|(?:^|\s)-list(?:[=\s]|$)/iu
export const MAKE_NON_VERDICT_OR_MUTATING_ARGUMENT = /(?:^|\s)(?:-n|-q|-t|--just-print|--recon|--question|--touch)(?:\s|$)/iu

export const PACKAGE_SCRIPT_ARGUMENTS = Object.freeze({
  selectorOptions: [
    '--workspace', '-w', '--filter', '--project', '--selectprojects',
    '--testnamepattern', '--testpathpattern', '--testpathpatterns',
    '--runtestsbypath', '--findrelatedtests', '--changedsince', '--shard',
    '--config', '-c', '--environment',
  ],
  pathSelectorOptions: [
    '--workspace', '-w', '--filter', '--project', '--runtestsbypath',
    '--findrelatedtests', '--config', '-c',
  ],
  valueOptions: [
    '--maxworkers', '--max-workers', '--maxconcurrency', '--testtimeout',
    '--hooktimeout', '--pool', '--pooloptions',
    '--reporter', '--timeout',
    '--concurrency', '--test-threads',
  ],
  optionalValueOptions: ['--bail', '--retry'],
  flagOptions: ['--runinband', '--ci', '--run', '--silent', '--verbose'],
})

export const PYTEST_ARGUMENTS = Object.freeze({
  selectorOptions: ['-k', '-m', '--ignore', '--ignore-glob', '--deselect', '-c'],
  selectorFlags: ['--lf', '--last-failed', '--ff', '--failed-first', '--sw', '--stepwise'],
  pathSelectorOptions: ['-c'],
  valueOptions: [
    '--maxfail', '--tb', '-n', '--dist', '--durations', '--timeout',
    '--basetemp', '--rootdir', '--confcutdir', '--capture', '--color',
  ],
  flagOptions: [
    '-q', '--quiet', '-v', '--verbose', '-s', '-x', '--exitfirst',
    '--disable-warnings', '--strict-markers', '--strict-config',
  ],
})

export const JEST_ARGUMENTS = Object.freeze({
  selectorOptions: [
    '-t', '--testnamepattern', '--testpathpattern', '--testpathpatterns',
    '--runtestsbypath', '--project', '--selectprojects', '--findrelatedtests',
    '--changedsince', '--shard',
  ],
  selectorFlags: ['--onlychanged', '-o', '--lastcommit', '--changedfileswithancestor'],
  pathSelectorOptions: ['--testpathpattern', '--testpathpatterns', '--runtestsbypath', '--findrelatedtests', '--project'],
  valueOptions: [
    '--maxworkers', '-w', '--maxconcurrency', '--testtimeout', '--hooktimeout',
    '--slowtestthreshold', '--pool', '--pooloptions',
    '--environment', '--reporter', '--sequence',
  ],
  optionalValueOptions: ['--bail', '--retry'],
  flagOptions: [
    '--runinband', '--ci', '--run', '--silent', '--verbose',
    '--detectopenhandles', '--forceexit', '--nostacktrace',
  ],
  cwdValueOptions: {
    '--config': ['jest.config.js', 'jest.config.cjs', 'jest.config.mjs', 'jest.config.ts'],
    '-c': ['jest.config.js', 'jest.config.cjs', 'jest.config.mjs', 'jest.config.ts'],
  },
})

export const VITEST_ARGUMENTS = Object.freeze({
  selectorOptions: [
    '-t', '--testnamepattern', '--project', '--related', '--changed', '--shard',
    '--config', '-c', '--environment',
  ],
  pathSelectorOptions: ['--project', '--related', '--config', '-c'],
  valueOptions: [
    '--maxworkers', '--maxconcurrency', '--testtimeout', '--hooktimeout',
    '--slowtestthreshold', '--pool', '--pooloptions', '--reporter', '--sequence',
  ],
  optionalValueOptions: ['--bail', '--retry'],
  flagOptions: ['--run', '--silent', '--reporter=default'],
})

export const NODE_TEST_ARGUMENTS = Object.freeze({
  selectorOptions: ['--test-name-pattern', '--test-skip-pattern', '--test-shard'],
  selectorFlags: ['--test-only'],
  valueOptions: [
    '--test-concurrency', '--test-timeout', '--test-reporter',
    '--test-reporter-destination',
  ],
  flagOptions: ['--test-force-exit'],
})

export const GO_TEST_ARGUMENTS = Object.freeze({
  selectorOptions: ['-run', '-bench', '-fuzz', '-skip'],
  selectorFlags: ['-short'],
  valueOptions: [
    '-p', '-count', '-timeout', '-parallel', '-cpu', '-benchtime', '-vet',
    '-shuffle', '-covermode', '-coverpkg', '-tags', '-mod', '-modfile',
  ],
  flagOptions: ['-v', '-json', '-race', '-failfast', '-cover'],
})

export const CARGO_ARGUMENTS = Object.freeze({
  selectorOptions: [
    '-p', '--package', '--test', '--bin', '--example', '--bench', '--exclude',
  ],
  selectorFlags: [
    '--lib', '--bins', '--tests', '--benches', '--examples', '--ignored',
    '--include-ignored',
  ],
  valueOptions: [
    '-j', '--jobs', '--features', '--profile', '--target',
    '--color', '--message-format', '--test-threads', '--format',
  ],
  flagOptions: [
    '--workspace', '--all', '--all-targets', '--all-features', '--release',
    '--locked', '--offline', '--frozen', '--verbose', '-v', '--quiet', '-q',
    '--nocapture', '--show-output',
  ],
  cwdValueOptions: {
    '--manifest-path': ['cargo.toml', './cargo.toml'],
  },
})

export const DOTNET_ARGUMENTS = Object.freeze({
  selectorOptions: ['--filter', '--framework', '-f', '--runtime', '-r', '--settings', '-s'],
  pathSelectorOptions: ['--settings', '-s'],
  valueOptions: [
    '--configuration', '-c', '--verbosity', '-v', '--logger', '-l',
    '--results-directory', '--test-adapter-path',
    '--blame-hang-timeout', '--arch', '--os', '--maxcpucount', '-m',
  ],
  flagOptions: ['--no-build', '--no-restore', '--nologo', '--interactive'],
})

export const ESLINT_ARGUMENTS = Object.freeze({
  selectorOptions: ['--ignore-pattern', '--config', '-c'],
  pathSelectorOptions: ['--config', '-c'],
  valueOptions: [
    '--ext', '--format', '-f', '--max-warnings', '--parser',
    '--parser-options', '--plugin', '--resolve-plugins-relative-to', '--rule',
    '--rulesdir', '--stdin-filename', '--concurrency',
  ],
  selectorFlags: ['--quiet'],
  flagOptions: ['--no-ignore', '--no-warn-ignored', '--no-error-on-unmatched-pattern'],
})

export const RUFF_ARGUMENTS = Object.freeze({
  selectorOptions: [
    '--select', '--extend-select', '--ignore', '--extend-ignore', '--exclude',
    '--extend-exclude', '--per-file-ignores', '--config',
  ],
  pathSelectorOptions: ['--config'],
  valueOptions: [
    '--target-version', '--line-length', '--output-format',
  ],
  flagOptions: [
    '--preview', '--respect-gitignore', '--no-respect-gitignore',
    '--force-exclude', '--verbose', '--quiet', '--silent',
  ],
})

export const MYPY_ARGUMENTS = Object.freeze({
  selectorOptions: [
    '--package', '-p', '--module', '-m', '--command', '-c', '--config-file',
  ],
  pathSelectorOptions: ['--config-file'],
  valueOptions: [
    '--python-version', '--platform', '--cache-dir',
    '--python-executable', '--custom-typeshed-dir', '--follow-imports',
  ],
  flagOptions: [
    '--strict', '--incremental', '--no-incremental', '--pretty',
    '--show-error-codes', '--hide-error-codes',
  ],
})

export const TSC_ARGUMENTS = Object.freeze({
  selectorOptions: ['--project', '-p'],
  pathSelectorOptions: ['--project', '-p'],
  valueOptions: [
    '--target', '-t', '--module', '-m', '--module-resolution',
    '--jsx', '--lib', '--types', '--type-roots', '--max-node-module-js-depth',
  ],
  optionalValueOptions: ['--pretty'],
  flagOptions: ['--noemit', '--strict', '--incremental'],
})

export const GO_PROJECT_ARGUMENTS = Object.freeze({
  valueOptions: ['-p', '-tags', '-mod', '-modfile', '-gcflags', '-asmflags', '-ldflags'],
  flagOptions: ['-v', '-x', '-race'],
})

export const MAVEN_ARGUMENTS = Object.freeze({
  selectorOptions: [
    '-dtest', '-dit.test', '-dgroups', '-dexcludedgroups', '-dincludes',
    '-dexcludes', '-pl', '--projects', '-rf', '--resume-from',
  ],
  valueOptions: [
    '-s', '--settings', '-gs', '--global-settings',
    '-t', '--toolchains', '-l', '--log-file',
  ],
  flagOptions: ['-q', '--quiet', '-v', '--version', '-ntp', '--no-transfer-progress'],
  cwdValueOptions: {
    '-f': ['pom.xml', './pom.xml'],
    '--file': ['pom.xml', './pom.xml'],
  },
})

export const GRADLE_ARGUMENTS = Object.freeze({
  selectorOptions: ['--tests', '-p', '--project-dir'],
  pathSelectorOptions: ['-p', '--project-dir'],
  valueOptions: [
    '--max-workers', '--console', '--warning-mode', '--configuration-cache-problems',
    '--dependency-verification',
  ],
  flagOptions: ['-q', '--quiet', '-i', '--info', '-s', '--stacktrace', '--scan'],
})

export const MAKE_ARGUMENTS = Object.freeze({
  selectorOptions: ['-c', '--directory'],
  pathSelectorOptions: ['-c', '--directory'],
  valueOptions: ['-j', '--jobs', '-i', '--include-dir'],
  flagOptions: ['-k', '--keep-going', '-s', '--silent', '--no-print-directory'],
  cwdValueOptions: {
    '-f': ['makefile', './makefile', 'Makefile', './Makefile', 'GNUmakefile', './GNUmakefile'],
    '--file': ['makefile', './makefile', 'Makefile', './Makefile', 'GNUmakefile', './GNUmakefile'],
    '--makefile': ['makefile', './makefile', 'Makefile', './Makefile', 'GNUmakefile', './GNUmakefile'],
  },
})
