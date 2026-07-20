/** Optional peer — present when OCP is installed beside this provider. */
declare module "@opencode-compat/profile" {
  export function detect(options?: {
    env?: NodeJS.ProcessEnv
    home?: string
    argv?: string[]
    execPath?: string
    existsSync?: (path: string) => boolean
  }): {
    id: string
    supported: boolean
    source?: string
    message?: string
    profile: {
      id: string
      paths: {
        cacheDir: string
        configDir: string
        dataDir: string
      }
    }
  }
}
