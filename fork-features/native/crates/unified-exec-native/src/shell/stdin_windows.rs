//! Windows stdin with acknowledged, cancellable overlapped writes.
//!
//! Mio's named-pipe writer copies a whole caller buffer and acknowledges it
//! before the pipe accepts it. Own the overlapped operation instead: the buffer,
//! event and OVERLAPPED remain alive until GetOverlappedResult confirms completion,
//! including after CancelIoEx. No cancelled write survives into the next call.

use std::{
    fs, io,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    ptr,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use windows_sys::Win32::{
    Foundation::{ERROR_IO_PENDING, INVALID_HANDLE_VALUE},
    Storage::FileSystem::{
        FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, PIPE_ACCESS_OUTBOUND, WriteFile,
    },
    System::{
        IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED},
        Pipes::{
            CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
            PIPE_WAIT,
        },
        Threading::CreateEventW,
    },
};

use crate::task;
use tokio_util::sync::CancellationToken;

pub(super) struct StdinSender {
    file: fs::File,
    // Cancellation and check-then-submit must not pass each other: cancelling
    // before a queued worker starts must prevent its later WriteFile entirely.
    submission: parking_lot::Mutex<()>,
}

pub(super) fn pipe() -> io::Result<(fs::File, Arc<StdinSender>)> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let name = format!(
        r"\\.\pipe\omp-unified-exec-stdin-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    );
    let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    // SAFETY: wide is NUL-terminated and live for the call. The returned handle
    // is owned here, not registered with an IOCP or shared with another writer.
    let handle = unsafe {
        CreateNamedPipeW(
            wide.as_ptr(),
            PIPE_ACCESS_OUTBOUND | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            64 * 1024,
            64 * 1024,
            0,
            ptr::null(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: CreateNamedPipeW returned a fresh owned file handle.
    let file = unsafe { fs::File::from_raw_handle(handle) };
    let reader = fs::OpenOptions::new().read(true).open(&name)?;
    Ok((
        reader,
        Arc::new(StdinSender {
            file,
            submission: parking_lot::Mutex::new(()),
        }),
    ))
}

impl StdinSender {
    pub(super) async fn write(
        self: &Arc<Self>,
        data: Vec<u8>,
        closed: CancellationToken,
        cancel: task::CancelToken,
    ) -> napi::Result<()> {
        let sender = Arc::clone(self);
        let worker_closed = closed.clone();
        let worker_cancel = cancel.clone();
        let mut worker = tokio::task::spawn_blocking(move || {
            sender.write_blocking(&data, &worker_closed, &worker_cancel)
        });
        let reason = tokio::select! {
            biased;
            result = &mut worker => return Self::write_result(result, &closed, &cancel),
            () = closed.cancelled() => super::STDIN_CLOSED,
            _ = cancel.wait() => super::STDIN_WRITE_CANCELLED,
        };
        {
            let _submission = self.submission.lock();
            // SAFETY: this handle has only this serialized write. If submission
            // has not happened, the worker observes the already-cancelled token
            // while holding this same lock and never submits it.
            unsafe {
                CancelIoEx(self.file.as_raw_handle(), ptr::null());
            }
        }
        // CancelIoEx requests cancellation; only completion permits freeing the
        // buffer/event/OVERLAPPED or admitting another stdin write.
        let _completed = worker.await;
        Err(napi::Error::from_reason(if closed.is_cancelled() {
            super::STDIN_CLOSED
        } else {
            reason
        }))
    }

    fn write_result(
        result: Result<io::Result<()>, tokio::task::JoinError>,
        closed: &CancellationToken,
        cancel: &task::CancelToken,
    ) -> napi::Result<()> {
        result
            .map_err(|err| napi::Error::from_reason(format!("{}: {err}", super::STDIN_BROKEN)))?
            .map_err(|err| {
                if closed.is_cancelled() {
                    return napi::Error::from_reason(super::STDIN_CLOSED);
                }
                if cancel.aborted() {
                    return napi::Error::from_reason(super::STDIN_WRITE_CANCELLED);
                }
                napi::Error::from_reason(format!("{}: {err}", super::STDIN_BROKEN))
            })
    }

    fn write_blocking(
        &self,
        data: &[u8],
        closed: &CancellationToken,
        cancel: &task::CancelToken,
    ) -> io::Result<()> {
        // SAFETY: a fresh unnamed manual-reset event; OwnedHandle closes it only
        // after the final GetOverlappedResult has confirmed completion.
        let event = unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) };
        if event.is_null() {
            return Err(io::Error::last_os_error());
        }
        let event = unsafe { OwnedHandle::from_raw_handle(event) };
        let mut offset = 0;
        while offset < data.len() {
            let mut overlapped = OVERLAPPED {
                hEvent: event.as_raw_handle(),
                ..OVERLAPPED::default()
            };
            let length = (data.len() - offset).min(u32::MAX as usize) as u32;
            {
                let _submission = self.submission.lock();
                if closed.is_cancelled() || cancel.aborted() {
                    return Err(io::ErrorKind::Interrupted.into());
                }
                // SAFETY: data and overlapped keep their addresses and ownership
                // through GetOverlappedResult below. The file was opened overlapped;
                // WriteFile resets the manual-reset event for each new operation.
                let submitted = unsafe {
                    WriteFile(
                        self.file.as_raw_handle(),
                        data[offset..].as_ptr(),
                        length,
                        ptr::null_mut(),
                        &mut overlapped,
                    )
                };
                if submitted == 0 {
                    let error = io::Error::last_os_error();
                    if error.raw_os_error() != Some(ERROR_IO_PENDING as i32) {
                        return Err(error);
                    }
                }
            }
            let mut written = 0;
            // SAFETY: this is the same live handle and OVERLAPPED just submitted;
            // waiting also confirms cancellation before either can be released.
            if unsafe {
                GetOverlappedResult(self.file.as_raw_handle(), &overlapped, &mut written, 1)
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            if written == 0 {
                return Err(io::ErrorKind::WriteZero.into());
            }
            offset += written as usize;
        }
        Ok(())
    }
}
