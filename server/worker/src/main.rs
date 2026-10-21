use rquickjs::{Context, Function, Object, Runtime};
use serde_json::value::RawValue;
use std::io::{self, Read, Write};
use std::time::{Duration, Instant};

const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const HEAP_BYTES: usize = 32 * 1024 * 1024;
const STACK_BYTES: usize = 512 * 1024;
const EXECUTION_TIME: Duration = Duration::from_millis(500);
const WORKER_BUNDLE: &str = include_str!("../../../dist/server/worker.js");

#[derive(Clone, Copy)]
enum WorkerError {
    InvalidRequest,
    ExecutionLimit,
    ExecutionFailed,
    OutputClosed,
}

impl WorkerError {
    fn envelope(self) -> Option<&'static [u8]> {
        match self {
            Self::InvalidRequest => Some(b"{\"ok\":false,\"error\":\"invalid_request\"}"),
            Self::ExecutionLimit => Some(b"{\"ok\":false,\"error\":\"execution_limit\"}"),
            Self::ExecutionFailed => Some(b"{\"ok\":false,\"error\":\"execution_failed\"}"),
            // A partially written response must never be followed by another envelope.
            Self::OutputClosed => None,
        }
    }
}

fn main() {
    let stdout = io::stdout();
    let mut output = stdout.lock();
    if let Err(error) = run(&mut output) {
        if let Some(envelope) = error.envelope() {
            let _ = output.write_all(envelope);
        }
    }
}

fn run(output: &mut impl Write) -> Result<(), WorkerError> {
    set_process_limits()?;

    let stdin = io::stdin();
    let mut input = stdin.lock().take((MAX_REQUEST_BYTES + 1) as u64);
    let mut bytes = Vec::new();
    input
        .read_to_end(&mut bytes)
        .map_err(|_| WorkerError::ExecutionFailed)?;
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err(WorkerError::InvalidRequest);
    }
    let request = String::from_utf8(bytes).map_err(|_| WorkerError::InvalidRequest)?;

    let deadline = Instant::now() + EXECUTION_TIME;
    let runtime = Runtime::new().map_err(|error| engine_error(error, deadline))?;
    runtime.set_memory_limit(HEAP_BYTES);
    runtime.set_max_stack_size(STACK_BYTES);
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));
    let context = Context::full(&runtime).map_err(|error| engine_error(error, deadline))?;

    context.with(|ctx| {
        // This embedded, build-generated bundle is the only evaluated source code.
        ctx.eval::<(), _>(WORKER_BUNDLE)
            .map_err(|error| engine_error(error, deadline))?;
        let worker: Object = ctx
            .globals()
            .get("surenecoWorker")
            .map_err(|error| engine_error(error, deadline))?;
        let function: Function = worker
            .get("run")
            .map_err(|error| engine_error(error, deadline))?;
        let response: rquickjs::String = function
            .call((request.as_str(),))
            .map_err(|error| engine_error(error, deadline))?;
        let response = response
            .to_cstring()
            .map_err(|error| engine_error(error, deadline))?;
        if response.len() > MAX_RESPONSE_BYTES || Instant::now() >= deadline {
            return Err(WorkerError::ExecutionLimit);
        }
        // The fixed bundle owns envelope validation and error sanitization. Check
        // JSON without allocating a second copy of potentially large scan results.
        serde_json::from_str::<&RawValue>(response.as_str())
            .map_err(|_| WorkerError::ExecutionFailed)?;
        if Instant::now() >= deadline {
            return Err(WorkerError::ExecutionLimit);
        }
        output
            .write_all(response.as_str().as_bytes())
            .map_err(|_| WorkerError::OutputClosed)
    })
}

fn engine_error(error: rquickjs::Error, deadline: Instant) -> WorkerError {
    // Never stringify exceptions: they can contain patterns or entire post bodies.
    if Instant::now() >= deadline || matches!(error, rquickjs::Error::Allocation) {
        WorkerError::ExecutionLimit
    } else {
        WorkerError::ExecutionFailed
    }
}

#[cfg(target_os = "linux")]
fn set_process_limits() -> Result<(), WorkerError> {
    let lower_limit = |resource, maximum| {
        let mut limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        // SAFETY: Both calls receive a valid pointer to the correctly sized rlimit.
        if unsafe { libc::getrlimit(resource, &mut limit) } != 0 {
            return Err(WorkerError::ExecutionFailed);
        }
        // Preserve stricter inherited limits rather than raising them.
        limit.rlim_cur = limit.rlim_cur.min(maximum);
        limit.rlim_max = limit.rlim_max.min(maximum);
        if unsafe { libc::setrlimit(resource, &limit) } != 0 {
            return Err(WorkerError::ExecutionFailed);
        }
        Ok(())
    };
    lower_limit(libc::RLIMIT_AS, 128 * 1024 * 1024)?;
    // Some regexp execution paths may not poll QuickJS's interrupt handler.
    // PHP must additionally enforce its one-second wall deadline and kill/reap us.
    lower_limit(libc::RLIMIT_CPU, 1)
}

#[cfg(not(target_os = "linux"))]
fn set_process_limits() -> Result<(), WorkerError> {
    Ok(())
}
