use rquickjs::{Context, Function, Object, Runtime};
use std::io::{self, Read, Write};
use std::time::{Duration, Instant};

const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const HEAP_BYTES: usize = 64 * 1024 * 1024;
const STACK_BYTES: usize = 512 * 1024;
const EXECUTION_TIME: Duration = Duration::from_millis(500);
const WORKER_BUNDLE: &str = include_str!("../../../../dist/php-fcm/worker.js");

enum WorkerError {
    InvalidRequest,
    ExecutionLimit,
    ExecutionFailed,
    OutputClosed,
}

impl WorkerError {
    fn envelope(self) -> Option<&'static [u8]> {
        match self {
            Self::InvalidRequest => Some(br#"{"ok":false,"error":"invalid_request"}"#),
            Self::ExecutionLimit => Some(br#"{"ok":false,"error":"execution_limit"}"#),
            Self::ExecutionFailed => Some(br#"{"ok":false,"error":"execution_failed"}"#),
            // Never append an error to a partially written response.
            Self::OutputClosed => None,
        }
    }
}

fn main() {
    let mut output = io::stdout().lock();
    if let Err(error) = run(&mut output) {
        if let Some(envelope) = error.envelope() {
            let _ = output.write_all(envelope);
        }
    }
}

fn run(output: &mut impl Write) -> Result<(), WorkerError> {
    set_process_limits()?;

    let mut bytes = Vec::new();
    io::stdin()
        .lock()
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| WorkerError::ExecutionFailed)?;
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err(WorkerError::InvalidRequest);
    }
    let request = String::from_utf8(bytes).map_err(|_| WorkerError::InvalidRequest)?;

    let deadline = Instant::now() + EXECUTION_TIME;
    let engine_error = |error| {
        // Never render QuickJS errors: they can contain untrusted input.
        if Instant::now() >= deadline || matches!(error, rquickjs::Error::Allocation) {
            WorkerError::ExecutionLimit
        } else {
            WorkerError::ExecutionFailed
        }
    };
    let runtime = Runtime::new().map_err(engine_error)?;
    runtime.set_memory_limit(HEAP_BYTES);
    runtime.set_max_stack_size(STACK_BYTES);
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));
    let context = Context::full(&runtime).map_err(engine_error)?;

    context.with(|ctx| {
        // No host bindings or module loader. The embedded bundle is the only source
        // evaluated, and stdin is passed to it as a string argument, not as code.
        ctx.eval::<(), _>(WORKER_BUNDLE).map_err(engine_error)?;
        let worker: Object = ctx.globals().get("surenecoWorker").map_err(engine_error)?;
        let run: Function = worker.get("run").map_err(engine_error)?;
        let response: rquickjs::String = run.call((request.as_str(),)).map_err(engine_error)?;
        let response = response.to_cstring().map_err(engine_error)?;
        if response.len() > MAX_RESPONSE_BYTES || Instant::now() >= deadline {
            return Err(WorkerError::ExecutionLimit);
        }
        output
            .write_all(response.as_str().as_bytes())
            .map_err(|_| WorkerError::OutputClosed)
    })
}

#[cfg(target_os = "linux")]
fn set_process_limits() -> Result<(), WorkerError> {
    let lower_limit = |resource, maximum| {
        let mut limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        // SAFETY: Both calls receive a pointer to a valid rlimit.
        if unsafe { libc::getrlimit(resource, &mut limit) } != 0 {
            return Err(WorkerError::ExecutionFailed);
        }
        limit.rlim_cur = limit.rlim_cur.min(maximum);
        limit.rlim_max = limit.rlim_max.min(maximum);
        if unsafe { libc::setrlimit(resource, &limit) } != 0 {
            return Err(WorkerError::ExecutionFailed);
        }
        Ok(())
    };
    lower_limit(libc::RLIMIT_AS, 128 * 1024 * 1024)?;
    // Regexp paths may not poll QuickJS interrupts. PHP must additionally
    // impose a wall-clock deadline covering both stdin and execution.
    lower_limit(libc::RLIMIT_CPU, 1)
}

#[cfg(not(target_os = "linux"))]
fn set_process_limits() -> Result<(), WorkerError> {
    Ok(())
}
