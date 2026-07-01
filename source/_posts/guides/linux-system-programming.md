---
title: "Linux 系统编程：进程、文件 I/O、IPC 与网络"
date: 2025-11-13T21:34:06+08:00
categories: ["知识向"]
tags: ["Linux", "系统编程", "C"]
cover: /images/guides/linux-system-programming/cover.png
top_img: false
---

Linux 系统编程是直接调用内核提供的系统调用来完成进程管理、文件操作、网络通信等任务。和应用层库不同，系统调用是程序和操作系统内核之间最直接的接口。

这篇覆盖嵌入式 Linux 开发里最常用的几块：进程与信号、文件与 I/O、进程间通信、网络编程。

---

## 一、进程与信号

### 进程基础

程序是磁盘上的可执行文件，进程是程序运行起来之后的实体。同一个程序可以同时跑多个进程，比如你开两个终端各跑一个 `vim`，这是两个进程，各自有独立的状态，互不干扰。

每个进程有独立的地址空间——代码段、数据段、堆、栈都是自己的，内核通过页表保证进程之间不能互相读写内存。这个隔离是操作系统稳定性的基础：一个进程崩溃，其他进程不受影响。

进程在运行过程中有几种状态：

- **运行（Running）**：正在占用 CPU 执行
- **可运行（Runnable）**：准备好了，等待调度器分配 CPU
- **睡眠（Sleeping）**：在等待某个事件（I/O、信号、定时器），不占 CPU
- **僵尸（Zombie）**：进程已经退出，但父进程还没调用 `wait` 回收，进程表项还在
- **停止（Stopped）**：收到 `SIGSTOP` 被暂停

每个进程有唯一的 PID，`ps aux` 可以查看所有进程，`/proc/<pid>/` 目录下存放着进程的所有运行时信息——内存映射、打开的文件、信号状态等。

### fork：创建子进程

`fork()` 把当前进程完整复制一份，得到一个子进程。调用一次，返回两次：父进程里返回子进程的 PID，子进程里返回 0。

```c
#include <unistd.h>
#include <stdio.h>
#include <sys/wait.h>

int main() {
    pid_t pid = fork();

    if (pid < 0) {
        perror("fork");
        return 1;
    } else if (pid == 0) {
        printf("子进程，PID = %d\n", getpid());
    } else {
        printf("父进程，PID = %d，子进程 PID = %d\n", getpid(), pid);
    }

    return 0;
}
```

fork 之后子进程是父进程的完整拷贝——代码、数据、堆栈、文件描述符全部复制，但两者独立，改一个不影响另一个。

实际上现代内核用**写时复制（Copy-on-Write）**优化 fork：fork 之后父子进程共享同一份物理内存页，只有某一方要写的时候才真正复制那一页。这让 fork 很快，不需要立刻复制几百 MB 的内存。

### exec：替换进程映像

`exec` 把当前进程替换成另一个程序，原来的代码和数据全部丢弃，从新程序的 `main` 开始执行。

```c
#include <unistd.h>
#include <stdio.h>

int main() {
    pid_t pid = fork();

    if (pid == 0) {
        // 子进程里执行 ls -l
        char *args[] = {"ls", "-l", "/tmp", NULL};
        execvp("ls", args);
        perror("exec");  // exec 成功后这行不会执行
        return 1;
    }

    printf("父进程继续运行\n");
    return 0;
}
```

`fork` + `exec` 是 Linux 启动新程序的标准模式，Shell 执行命令就是这样做的。

### waitpid：回收子进程

子进程退出后，内核保留它的进程表项（包含退出状态），等父进程来读取。这段时间子进程处于僵尸状态——它已经不运行了，但 PID 还占着，`ps` 里能看到状态是 `Z`。

如果父进程一直不回收，僵尸进程越积越多，PID 资源耗尽，系统就无法创建新进程。`waitpid()` 读取子进程退出状态并清理这个表项：

```c
int status;
pid_t child = waitpid(pid, &status, 0);  // 0 表示阻塞等待

if (WIFEXITED(status)) {
    printf("子进程正常退出，退出码 = %d\n", WEXITSTATUS(status));
}
```

`WNOHANG` 作为第三个参数可以非阻塞检查：有子进程结束返回其 PID，没有返回 0。

### 信号

信号是进程间发送异步通知的机制，类似硬件中断。常见信号：

| 信号 | 含义 | 默认行为 |
|------|------|---------|
| `SIGTERM` | 请求终止 | 进程退出 |
| `SIGKILL` | 强制终止 | 进程退出，不可捕获 |
| `SIGINT` | Ctrl+C | 进程退出 |
| `SIGSEGV` | 段错误 | 进程崩溃 |
| `SIGCHLD` | 子进程状态变化 | 忽略 |
| `SIGUSR1/2` | 用户自定义 | 进程退出 |

发送信号：

```c
kill(pid, SIGTERM);   // 代码里发信号
```

用 `sigaction` 注册信号处理函数：

```c
#include <signal.h>
#include <stdio.h>
#include <unistd.h>

static volatile int running = 1;

void sig_handler(int signo) {
    if (signo == SIGINT) {
        running = 0;
    }
}

int main() {
    struct sigaction sa = {};
    sa.sa_handler = sig_handler;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGINT, &sa, NULL);

    printf("运行中，按 Ctrl+C 退出\n");
    while (running) {
        sleep(1);
    }
    printf("正常退出\n");
    return 0;
}
```

`running` 必须加 `volatile`——信号处理函数异步调用，编译器不知道它会修改这个变量，不加 `volatile` 可能被优化掉，循环变成死循环。

信号处理函数是被内核在任意时刻插入执行的，就像硬件中断处理函数。它可能打断主程序正在执行的任何代码——包括正在 `malloc` 内部持有锁的时候。如果信号处理函数里也调用 `malloc`，就会发生死锁。所以信号处理函数里只能调用**异步信号安全**的函数，这个列表在 `man 7 signal-safety` 里，`printf` 严格来说不在其中，但实践中常用。推荐的做法是在信号处理函数里只设置一个 `volatile` 标志位，主循环里检查这个标志位再做实际处理。

---

## 二、文件与 I/O

### 一切皆文件

"一切皆文件"是 Linux 的核心设计哲学。普通文件、目录、硬件设备（`/dev/ttyUSB0`、`/dev/sda`）、管道、socket，在内核里都用同一套接口操作——`open`、`read`、`write`、`close`。

这个设计的好处很实际：你写一段读串口的代码，换成读普通文件几乎不用改，因为接口一样。网络 socket 也是文件描述符，所以 `read`/`write` 直接能用。

文件描述符（fd）是一个整数，是进程和内核之间的句柄。内核里每个进程维护一张文件描述符表，fd 就是这张表的下标，表里存着指向内核文件结构体的指针。进程只操作 fd 这个整数，真正的资源管理在内核里。

每个进程启动时默认有三个 fd：

- `0`：标准输入 stdin
- `1`：标准输出 stdout
- `2`：标准错误 stderr

`open()` 从 3 开始分配，关闭后这个编号可以复用。

### 基本文件操作

核心 API：

```c
int open(const char *pathname, int flags, mode_t mode);
```
- `pathname`：文件路径
- `flags`：打开方式，必须包含 `O_RDONLY`/`O_WRONLY`/`O_RDWR` 之一，可用 `|` 追加其他标志
- `mode`：创建文件时的权限位，如 `0644`；不创建文件时可省略
- 返回文件描述符，失败返回 -1

```c
ssize_t read(int fd, void *buf, size_t count);
ssize_t write(int fd, const void *buf, size_t count);
```
- `buf`：用户缓冲区指针
- `count`：最多读/写的字节数
- 返回实际读/写字节数；`read` 返回 0 表示到达文件末尾（EOF）；返回 -1 表示出错

```c
off_t lseek(int fd, off_t offset, int whence);
```
- `offset`：偏移量（字节），可以为负数
- `whence`：基准位置，`SEEK_SET`（文件开头）、`SEEK_CUR`（当前位置）、`SEEK_END`（文件末尾）
- 返回新的文件偏移量；`lseek(fd, 0, SEEK_END)` 可用来获取文件大小

```c
int close(int fd);
```
- 关闭文件描述符，释放内核资源；进程退出时所有 fd 自动关闭，但不要依赖这一点

`open()` 常用 flags：

| flag | 含义 |
|------|------|
| `O_RDONLY` | 只读 |
| `O_WRONLY` | 只写 |
| `O_RDWR` | 读写 |
| `O_CREAT` | 不存在则创建 |
| `O_TRUNC` | 打开时清空 |
| `O_APPEND` | 追加写 |
| `O_NONBLOCK` | 非阻塞 |

使用示例：

```c
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>

int main() {
    // 打开文件，不存在则创建，权限 0644
    int fd = open("test.txt", O_CREAT | O_RDWR | O_TRUNC, 0644);
    if (fd < 0) { perror("open"); return 1; }

    // 写入
    const char *msg = "hello, linux\n";
    write(fd, msg, 13);

    // 移动到开头
    lseek(fd, 0, SEEK_SET);

    // 读取
    char buf[64] = {};
    ssize_t n = read(fd, buf, sizeof(buf));
    printf("读到 %zd 字节：%s", n, buf);

    close(fd);
    return 0;
}
```

### 非阻塞 I/O

默认 `read()` 是阻塞的，没有数据就一直等。对设备、管道、socket，阻塞会让程序卡死。`O_NONBLOCK` 让没有数据时立刻返回 `-1`，`errno` 为 `EAGAIN`：

```c
int fd = open("/dev/ttyUSB0", O_RDWR | O_NONBLOCK);

char buf[64];
ssize_t n = read(fd, buf, sizeof(buf));
if (n < 0 && errno == EAGAIN) {
    // 没有数据，稍后再试
}
```

对已有 fd 用 `fcntl` 设置：

```c
int fcntl(int fd, int cmd, ... /* arg */);
```
- `F_GETFL`：获取 fd 当前的状态标志（返回值就是 flags）
- `F_SETFL`：设置 fd 的状态标志（传入新的 flags）
- 常见用法是先 `F_GETFL` 取出原有标志，再或上 `O_NONBLOCK` 后写回，避免覆盖其他标志

```c
int flags = fcntl(fd, F_GETFL);
fcntl(fd, F_SETFL, flags | O_NONBLOCK);
```

### select / poll

非阻塞轮询 CPU 空转很低效。`select` 和 `poll` 让内核监听多个 fd，有任何一个就绪才返回：

```c
int select(int nfds, fd_set *readfds, fd_set *writefds, fd_set *exceptfds,
           struct timeval *timeout);
```
- `nfds`：监听的 fd 中最大值加 1（内核用来确定扫描范围）
- `readfds`：关心"可读"事件的 fd 集合，传 `NULL` 表示不关心
- `writefds`：关心"可写"事件的 fd 集合
- `exceptfds`：关心"异常"事件的 fd 集合，通常传 `NULL`
- `timeout`：超时时间，`NULL` 表示无限等，`{0, 0}` 表示立刻返回（纯轮询）
- 返回就绪 fd 的总数，0 表示超时，-1 表示出错

操作 `fd_set` 的四个宏：
- `FD_ZERO(&set)`：清空集合
- `FD_SET(fd, &set)`：把 fd 加入集合
- `FD_CLR(fd, &set)`：把 fd 从集合移除
- `FD_ISSET(fd, &set)`：检查 fd 是否在集合里（`select` 返回后用这个判断哪个就绪）

```c
#include <sys/select.h>

fd_set readfds;
FD_ZERO(&readfds);
FD_SET(fd1, &readfds);
FD_SET(fd2, &readfds);

struct timeval timeout = {5, 0};  // 5 秒超时
int ret = select(fd2 + 1, &readfds, NULL, NULL, &timeout);

if (ret == 0) {
    printf("超时\n");
} else {
    if (FD_ISSET(fd1, &readfds)) { /* fd1 可读 */ }
    if (FD_ISSET(fd2, &readfds)) { /* fd2 可读 */ }
}
```

`select` 的问题：fd 上限 1024，每次调用要重设 `fd_set`，内核遍历全部 fd，fd 多了性能差。`poll` 取消了 1024 限制，但内核遍历问题没解决。

### epoll

epoll 用事件驱动，只通知就绪的 fd，O(1) 复杂度，是高性能服务器的核心：

```c
#include <sys/epoll.h>

int epfd = epoll_create1(0);

struct epoll_event ev;
ev.events = EPOLLIN;
ev.data.fd = fd1;
epoll_ctl(epfd, EPOLL_CTL_ADD, fd1, &ev);  // 注册 fd

struct epoll_event events[10];
int n = epoll_wait(epfd, events, 10, -1);  // 等待，-1 无限

for (int i = 0; i < n; i++) {
    if (events[i].events & EPOLLIN) {
        char buf[64] = {};
        read(events[i].data.fd, buf, sizeof(buf));
    }
}

close(epfd);
```

epoll 三个接口：

```c
int epoll_create1(int flags);
```
- `flags`：通常填 0；`EPOLL_CLOEXEC` 表示 exec 后自动关闭该 fd
- 返回 epoll 实例的文件描述符

```c
int epoll_ctl(int epfd, int op, int fd, struct epoll_event *event);
```
- `epfd`：epoll 实例 fd
- `op`：操作类型，`EPOLL_CTL_ADD`（注册）、`EPOLL_CTL_DEL`（删除）、`EPOLL_CTL_MOD`（修改）
- `fd`：要监听的目标 fd
- `event`：监听的事件类型，`EPOLLIN`（可读）、`EPOLLOUT`（可写）、`EPOLLET`（ET 模式）

```c
int epoll_wait(int epfd, struct epoll_event *events, int maxevents, int timeout);
```
- `events`：输出数组，存放就绪的事件
- `maxevents`：数组大小，最多返回多少个事件
- `timeout`：超时毫秒数，-1 表示无限等待，0 表示立即返回
- 返回就绪事件数量

**LT 和 ET 模式**

理解这两种模式需要先明白 epoll 在监听什么：它监听的是 fd 的**状态**。

- **LT（水平触发，默认）**：只要 fd 处于"有数据可读"的状态，每次 `epoll_wait` 就通知你。你可以分多次慢慢读，只要没读完，下次调用还会通知。
- **ET（边缘触发）**：只在状态**发生变化**时通知一次——从"没数据"变成"有数据"的那一刻。之后不管你读没读完，不再通知，直到又有新数据到来触发新的状态变化。

ET 模式下如果只读了一部分就返回，剩下的数据再也不会触发通知，就永远堆在缓冲区里。所以 ET 必须循环读直到 `EAGAIN`（表示缓冲区已空）：

```c
ev.events = EPOLLIN | EPOLLET;  // 开启 ET 模式

// ET 下必须循环读直到 EAGAIN
while (1) {
    ssize_t n = read(fd, buf, sizeof(buf));
    if (n < 0) {
        if (errno == EAGAIN) break;  // 读完了
        break;
    }
    if (n == 0) break;  // 对端关闭
    process(buf, n);
}
```

### mmap：内存映射

普通的文件读写流程是：`read` 系统调用 → 内核把磁盘数据读到页缓存 → 再从页缓存拷贝到用户空间缓冲区。有两次拷贝，还有系统调用开销。

`mmap` 直接把文件的页缓存映射到进程地址空间，访问这块内存时如果数据不在内存里，内核自动触发缺页中断把数据从磁盘加载进来。整个过程没有额外的拷贝，访问文件就像访问内存数组，随机访问性能比 `lseek` + `read` 好很多。

```c
#include <sys/mman.h>

int fd = open("data.bin", O_RDWR | O_CREAT, 0644);
ftruncate(fd, 4096);

char *ptr = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
close(fd);  // 映射建立后 fd 可以关了

strcpy(ptr, "hello mmap");       // 直接读写，就是在操作文件
msync(ptr, 4096, MS_SYNC);       // 强制刷到磁盘
munmap(ptr, 4096);
```

`mmap` 适合：大文件随机访问、进程间共享内存、嵌入式 Linux 驱动里访问设备寄存器。

### ioctl：设备控制

`ioctl`（input/output control）是 `read`/`write` 的补充——凡是无法用读写表达的设备控制操作，都通过 `ioctl` 来做。设置串口波特率、查询网卡信息、控制终端窗口大小，本质上都是同一个系统调用：

```c
#include <sys/ioctl.h>

int ioctl(int fd, unsigned long request, ...);
```

`fd` 是设备文件描述符，`request` 是操作码（由驱动定义），第三个参数是传入或传出的数据指针。

**串口波特率设置：**

```c
#include <termios.h>

int fd = open("/dev/ttyS0", O_RDWR);

struct termios tty;
tcgetattr(fd, &tty);           // 读取当前配置（底层是 ioctl）
cfsetspeed(&tty, B115200);     // 设置波特率
tty.c_cflag &= ~PARENB;        // 无校验位
tty.c_cflag &= ~CSTOPB;        // 1 个停止位
tty.c_cflag = (tty.c_cflag & ~CSIZE) | CS8;  // 8 位数据位
tcsetattr(fd, TCSANOW, &tty);  // 应用配置
```

**查询网卡 MAC 地址：**

```c
#include <net/if.h>
#include <sys/socket.h>

int fd = socket(AF_INET, SOCK_DGRAM, 0);

struct ifreq ifr;
strncpy(ifr.ifr_name, "eth0", IFNAMSIZ);
ioctl(fd, SIOCGIFHWADDR, &ifr);

unsigned char *mac = (unsigned char *)ifr.ifr_hwaddr.sa_data;
printf("%02x:%02x:%02x:%02x:%02x:%02x\n",
       mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
close(fd);
```

**查询终端窗口大小：**

```c
struct winsize ws;
ioctl(STDOUT_FILENO, TIOCGWINSZ, &ws);
printf("rows=%d cols=%d\n", ws.ws_row, ws.ws_col);
```

嵌入式驱动开发里，驱动通过 `_IO`/`_IOR`/`_IOW`/`_IOWR` 宏定义自己的操作码，用户程序再通过 `ioctl` 调用。`read`/`write` 负责数据流，`ioctl` 负责控制面，两者分工明确。

---

## 三、进程间通信（IPC）

进程有独立地址空间，不能直接读写对方的内存。内核提供了几种 IPC 机制。

### 管道（Pipe）

管道是单向字节流，只能用于有亲缘关系的进程（父子进程）。

```c
int pipe(int pipefd[2]);
```

- `pipefd[0]`：读端文件描述符
- `pipefd[1]`：写端文件描述符
- 返回 0 表示成功，-1 表示失败

创建管道后再 `fork()`，父子进程各自拿到两端的副本。通信是单向的，所以用不到的那端要关掉——否则写端没有全部关闭，读端的 `read()` 不知道数据是否结束，会一直阻塞等 EOF。

```c
#include <unistd.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>

int main() {
    int fd[2];
    pipe(fd);  // fd[0] 读端，fd[1] 写端

    pid_t pid = fork();

    if (pid == 0) {
        close(fd[0]);  // 子进程关闭读端
        const char *msg = "hello from child";
        write(fd[1], msg, strlen(msg));
        close(fd[1]);
        return 0;
    }

    close(fd[1]);  // 父进程关闭写端
    char buf[64] = {};
    read(fd[0], buf, sizeof(buf));
    printf("父进程收到：%s\n", buf);
    close(fd[0]);

    waitpid(pid, NULL, 0);
    return 0;
}
```

用完不需要的那端必须关掉——写端没有全部关闭，读端的 `read()` 不会返回 EOF，会一直阻塞。

Shell 里的 `ls | grep foo` 就是管道，`ls` 的 stdout 接到 `grep` 的 stdin。

### 命名管道（FIFO）

普通管道只能在父子进程间用，命名管道在文件系统里有路径，任意两个进程都能通过路径通信：

```c
int mkfifo(const char *pathname, mode_t mode);
```

- `pathname`：FIFO 文件的路径，如 `/tmp/myfifo`
- `mode`：权限位，如 `0666`
- 返回 0 成功，-1 失败（已存在会返回 `EEXIST`）

创建后用普通的 `open` / `read` / `write` / `close` 操作，和普通文件接口完全一样。区别在于 `open()` 会阻塞——写端 `open` 时会等读端也打开，反之亦然，两边都准备好才继续。

```c
// 进程 A：写
mkfifo("/tmp/myfifo", 0666);
int fd = open("/tmp/myfifo", O_WRONLY);
write(fd, "hello", 5);
close(fd);

// 进程 B：读
int fd = open("/tmp/myfifo", O_RDONLY);
char buf[64] = {};
read(fd, buf, sizeof(buf));
printf("收到：%s\n", buf);
close(fd);
```

`open()` 会阻塞直到另一端也打开——写端等读端，读端等写端，两边都准备好才继续。

### 共享内存

管道传数据要经过两次拷贝：写端把数据从用户空间拷到内核缓冲区，读端再从内核缓冲区拷到用户空间。每次 `write`/`read` 都要陷入内核，有系统调用开销。

共享内存完全不同——内核把同一块物理内存同时映射到两个进程的虚拟地址空间。进程 A 往这块地址写数据，进程 B 直接在自己的地址空间里就能读到，没有任何拷贝，也不需要系统调用，这就是零拷贝。

代价是没有任何同步保护，A 在写的时候 B 也可能在读，读到的是中间状态，数据损坏。所以共享内存几乎总是配合信号量一起用。

涉及的核心 API：

```c
int shm_open(const char *name, int oflag, mode_t mode);
```
- `name`：共享内存对象名，以 `/` 开头，如 `/myshm`
- `oflag`：`O_CREAT | O_RDWR` 创建并读写，`O_RDONLY` 只读
- `mode`：权限位，如 `0666`
- 返回文件描述符，失败返回 -1

```c
void *mmap(void *addr, size_t length, int prot, int flags, int fd, off_t offset);
```
- `addr`：映射起始地址，传 `NULL` 让内核自动选
- `length`：映射长度（字节）
- `prot`：`PROT_READ | PROT_WRITE` 可读写，`PROT_READ` 只读
- `flags`：`MAP_SHARED` 修改对其他进程可见，`MAP_PRIVATE` 写时复制（私有副本）
- `fd`：`shm_open` 返回的文件描述符
- `offset`：从文件哪个偏移开始映射，通常填 0
- 返回映射地址，失败返回 `MAP_FAILED`

```c
int shm_unlink(const char *name);  // 删除共享内存对象
int munmap(void *addr, size_t length);  // 解除映射
```


```c
#include <fcntl.h>
#include <sys/mman.h>
#include <string.h>
#include <unistd.h>
#include <stdio.h>

// 进程 A：创建并写入
int main() {
    int fd = shm_open("/myshm", O_CREAT | O_RDWR, 0666);
    ftruncate(fd, 4096);
    void *ptr = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    close(fd);

    strcpy((char *)ptr, "hello from A");
    sleep(3);  // 等进程 B 来读

    munmap(ptr, 4096);
    shm_unlink("/myshm");
    return 0;
}

// 进程 B：读取
int main() {
    int fd = shm_open("/myshm", O_RDONLY, 0666);
    void *ptr = mmap(NULL, 4096, PROT_READ, MAP_SHARED, fd, 0);
    close(fd);

    printf("B 读到：%s\n", (char *)ptr);
    munmap(ptr, 4096);
    return 0;
}
```

编译加 `-lrt`。共享内存没有任何同步保护，多进程同时读写必须配合信号量。

### 信号量（Semaphore）

信号量是一个整数计数器，配合两个原子操作使用：

- `sem_wait()`：计数器减 1。如果减完之后小于 0，调用方阻塞，直到别人 `post`
- `sem_post()`：计数器加 1，如果有人在等，唤醒其中一个

初始值决定了信号量的语义。初始值设为 1，就是一把互斥锁——同时只允许一个人进临界区；初始值设为 0，就是一个通知机制——一方等待，另一方完成后发出信号；初始值设为 N，就是限制并发数量最多 N 个。

配合共享内存的典型用法是初始值 0：进程 B 调用 `sem_wait` 阻塞等待，进程 A 写完数据后调用 `sem_post` 通知，B 被唤醒后安全读取。

核心 API：

```c
sem_t *sem_open(const char *name, int oflag, mode_t mode, unsigned int value);
```
- `name`：信号量名，以 `/` 开头
- `oflag`：`O_CREAT` 创建，`O_CREAT | O_EXCL` 创建且若已存在则报错
- `mode`：权限位，如 `0666`
- `value`：初始值，0 表示通知模式，1 表示互斥锁，N 表示并发限制

```c
int sem_wait(sem_t *sem);   // P 操作：计数 -1，为 0 则阻塞
int sem_post(sem_t *sem);   // V 操作：计数 +1，唤醒等待者
int sem_close(sem_t *sem);  // 关闭（不删除）
int sem_unlink(const char *name);  // 删除命名信号量
```

```c
#include <semaphore.h>
#include <fcntl.h>

// 创建命名信号量，初始值 0
sem_t *sem = sem_open("/mysem", O_CREAT, 0666, 0);

// 进程 A：写完数据后通知
strcpy(shm, "data ready");
sem_post(sem);

// 进程 B：等信号量再读
sem_wait(sem);
printf("读到：%s\n", (char *)shm);

sem_close(sem);
sem_unlink("/mysem");
```

### 消息队列

消息队列是内核维护的消息链表，支持双向通信和消息优先级，通过 POSIX mqueue 接口操作。

和管道相比有两个本质区别。管道是无结构的字节流，你往里写数据，对面读出来，自己判断边界。消息队列不一样——每次 `mq_send` 是一条独立的消息，`mq_receive` 收到的一定是完整的一条，不会粘在一起，也不会被拆开。

另一个区别是优先级。消息队列里的消息按优先级排序，`mq_receive` 总是先取出优先级最高的那条，而不是最早进来的那条。这对需要插队处理紧急消息的场景很有用，比如传感器报警消息要比普通数据包先处理。

核心 API：

```c
mqd_t mq_open(const char *name, int oflag, mode_t mode, struct mq_attr *attr);
```
- `name`：消息队列名，以 `/` 开头
- `oflag`：`O_CREAT | O_WRONLY` 创建写端，`O_RDONLY` 读端
- `mode`：权限位，如 `0666`
- `attr`：队列属性，`NULL` 用默认值；指定时填 `mq_maxmsg`（队列最大消息数）和 `mq_msgsize`（每条消息最大字节数）

```c
int mq_send(mqd_t mqdes, const char *msg_ptr, size_t msg_len, unsigned int msg_prio);
```
- `msg_ptr`：消息内容指针
- `msg_len`：消息长度（字节），必须 ≤ `mq_msgsize`
- `msg_prio`：优先级，数字越大优先级越高，0 为最低

```c
ssize_t mq_receive(mqd_t mqdes, char *msg_ptr, size_t msg_len, unsigned int *msg_prio);
```
- `msg_len`：缓冲区大小，必须 ≥ `mq_msgsize`，否则报 `EMSGSIZE`
- `msg_prio`：输出参数，返回收到消息的优先级，不关心可传 `NULL`
- 返回实际收到的字节数

```c
int mq_close(mqd_t mqdes);         // 关闭描述符
int mq_unlink(const char *name);   // 删除消息队列
```

```c
#include <mqueue.h>

// 发送方
struct mq_attr attr = { .mq_maxmsg = 10, .mq_msgsize = 256 };
mqd_t mq = mq_open("/myqueue", O_CREAT | O_WRONLY, 0666, &attr);
mq_send(mq, "hello", 6, 0);
mq_close(mq);

// 接收方
mqd_t mq = mq_open("/myqueue", O_RDONLY);
char buf[256];
unsigned int priority;
mq_receive(mq, buf, sizeof(buf), &priority);
printf("收到：%s\n", buf);
mq_close(mq);
mq_unlink("/myqueue");
```

编译加 `-lrt`。

### IPC 方式对比

| 方式 | 方向 | 速度 | 适用场景 |
|------|------|------|---------|
| 管道 | 单向 | 中 | 父子进程，简单数据流 |
| 命名管道 | 单向 | 中 | 任意进程，简单数据流 |
| 共享内存 | 双向 | 最快 | 大量数据，需配合信号量 |
| 消息队列 | 双向 | 中 | 结构化消息，需要优先级 |
| Unix socket | 双向 | 快 | 同机器通用 IPC |

---

## 四、网络编程：Socket

Socket 是网络通信的抽象接口，本质上也是文件描述符，可以用 `read`/`write` 操作。

核心 API 一览：

```c
int socket(int domain, int type, int protocol);
```
- `domain`：地址族，`AF_INET`（IPv4）、`AF_INET6`（IPv6）、`AF_UNIX`（本机 Unix socket）
- `type`：`SOCK_STREAM`（TCP，字节流）、`SOCK_DGRAM`（UDP，数据报）
- `protocol`：通常填 0，让内核根据前两个参数自动选
- 返回 socket 文件描述符

```c
int bind(int sockfd, const struct sockaddr *addr, socklen_t addrlen);
```
- 把 socket 绑定到本地地址和端口
- `addr`：填 `struct sockaddr_in`（IPv4）并强转为 `struct sockaddr *`
- 服务器必须 bind；客户端通常不用，内核自动分配临时端口

```c
int listen(int sockfd, int backlog);
```
- 把 socket 设为监听状态，只有 TCP 服务器需要
- `backlog`：未完成连接队列的最大长度，通常填 10~128

```c
int accept(int sockfd, struct sockaddr *addr, socklen_t *addrlen);
```
- 从已完成连接队列取出一个连接，返回新的连接 fd
- `addr`：输出参数，填充客户端地址信息
- 没有新连接时阻塞等待

```c
int connect(int sockfd, const struct sockaddr *addr, socklen_t addrlen);
```
- 客户端主动发起连接，TCP 三次握手在这里完成
- 成功后这个 fd 就可以直接 `read`/`write`

```c
ssize_t send(int sockfd, const void *buf, size_t len, int flags);
ssize_t recv(int sockfd, void *buf, size_t len, int flags);
```
- TCP 专用的发送/接收，`flags` 通常填 0，等同于 `write`/`read`

```c
ssize_t sendto(int sockfd, const void *buf, size_t len, int flags,
               const struct sockaddr *dest_addr, socklen_t addrlen);
ssize_t recvfrom(int sockfd, void *buf, size_t len, int flags,
                 struct sockaddr *src_addr, socklen_t *addrlen);
```
- UDP 专用，每次调用都要指定/获取对端地址，因为 UDP 无连接

### TCP 服务器

TCP 通信流程：`socket` → `bind` → `listen` → `accept` → `read/write` → `close`

```c
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <sys/socket.h>

int main() {
    int server_fd = socket(AF_INET, SOCK_STREAM, 0);

    int opt = 1;
    setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    struct sockaddr_in addr = {};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons(8080);
    bind(server_fd, (struct sockaddr *)&addr, sizeof(addr));

    listen(server_fd, 10);
    printf("监听 8080...\n");

    while (1) {
        struct sockaddr_in client = {};
        socklen_t len = sizeof(client);
        int conn = accept(server_fd, (struct sockaddr *)&client, &len);

        printf("连接来自：%s:%d\n",
               inet_ntoa(client.sin_addr), ntohs(client.sin_port));

        char buf[1024] = {};
        ssize_t n = read(conn, buf, sizeof(buf));
        printf("收到：%s\n", buf);
        write(conn, buf, n);  // echo 回去

        close(conn);
    }

    close(server_fd);
    return 0;
}
```

### TCP 客户端

```c
int fd = socket(AF_INET, SOCK_STREAM, 0);

struct sockaddr_in server = {};
server.sin_family = AF_INET;
server.sin_port = htons(8080);
inet_pton(AF_INET, "127.0.0.1", &server.sin_addr);

connect(fd, (struct sockaddr *)&server, sizeof(server));

write(fd, "hello", 5);

char buf[1024] = {};
read(fd, buf, sizeof(buf));
printf("收到：%s\n", buf);

close(fd);
```

### 字节序

字节序是多字节数据在内存中的存储顺序。一个 `int` 占 4 个字节，这 4 个字节放进内存时谁排在前面，不同架构的答案不同。

同一个 32 位整数 `0x12345678`，存在内存里有两种方式：

- **大端（Big-Endian）**：高字节存低地址，内存里是 `12 34 56 78`，看起来和写法一样
- **小端（Little-Endian）**：低字节存低地址，内存里是 `78 56 34 12`，和写法相反

x86/ARM 默认小端，网络协议（TCP/IP）规定用大端，也叫网络字节序。如果直接把本机的 `int` 发出去，对方可能是大端机器，读到的值就是错的。所以发送前要转换，接收后也要转换：

```c
htons(port)    // 16 位，host to network
htonl(addr)    // 32 位
ntohs(port)    // 16 位，network to host
ntohl(addr)    // 32 位

inet_pton(AF_INET, "192.168.1.1", &addr.sin_addr);   // 字符串转二进制
inet_ntop(AF_INET, &addr.sin_addr, buf, sizeof(buf)); // 二进制转字符串
```

### TCP 粘包问题

TCP 是**字节流**协议，不是消息协议。它只保证字节按顺序到达，不知道也不关心你的数据在逻辑上分几条消息。发送方调用两次 `write`，TCP 可能把它们合并成一个包发出去（Nagle 算法），接收方一次 `read` 就全收到了——这就是粘包。反过来，一次 `write` 的数据也可能被拆成多个包，接收方要调用多次 `read` 才能凑齐。

对比 UDP：UDP 是**数据报**协议，每次 `sendto` 就是一个独立的数据报，`recvfrom` 收到的一定是一个完整的数据报，没有粘包问题。但 UDP 可能丢包、乱序，需要应用层自己处理。

TCP 粘包的解决方案是自己定义消息边界，最常见的是**定长头部**：

```c
// 发送：先发 4 字节长度，再发数据
uint32_t net_len = htonl(data_len);
write(fd, &net_len, 4);
write(fd, data, data_len);

// 接收：循环读直到够数
ssize_t recv_all(int fd, void *buf, size_t n) {
    size_t received = 0;
    while (received < n) {
        ssize_t r = read(fd, (char *)buf + received, n - received);
        if (r <= 0) return r;
        received += r;
    }
    return received;
}

uint32_t net_len;
recv_all(fd, &net_len, 4);
uint32_t data_len = ntohl(net_len);
char *data = malloc(data_len);
recv_all(fd, data, data_len);
```

### UDP

UDP 不需要连接，直接发，每次 `recvfrom` 收到一个完整数据报，没有粘包问题：

```c
// 发送方
int fd = socket(AF_INET, SOCK_DGRAM, 0);
struct sockaddr_in dest = {};
dest.sin_family = AF_INET;
dest.sin_port = htons(9090);
inet_pton(AF_INET, "127.0.0.1", &dest.sin_addr);
sendto(fd, "hello", 5, 0, (struct sockaddr *)&dest, sizeof(dest));
close(fd);

// 接收方
int fd = socket(AF_INET, SOCK_DGRAM, 0);
struct sockaddr_in addr = {};
addr.sin_family = AF_INET;
addr.sin_addr.s_addr = INADDR_ANY;
addr.sin_port = htons(9090);
bind(fd, (struct sockaddr *)&addr, sizeof(addr));

char buf[1024];
struct sockaddr_in sender;
socklen_t sender_len = sizeof(sender);
recvfrom(fd, buf, sizeof(buf), 0, (struct sockaddr *)&sender, &sender_len);
```

### epoll + socket：事件驱动服务器

上面的服务器每次只能处理一个连接。用 epoll 可以单线程处理大量连接：

```c
#include <sys/epoll.h>
#include <sys/socket.h>
#include <arpa/inet.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <errno.h>

void set_nonblock(int fd) {
    int flags = fcntl(fd, F_GETFL);
    fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

int main() {
    int server_fd = socket(AF_INET, SOCK_STREAM, 0);
    int opt = 1;
    setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    struct sockaddr_in addr = {};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons(8080);
    bind(server_fd, (struct sockaddr *)&addr, sizeof(addr));
    listen(server_fd, 128);
    set_nonblock(server_fd);

    int epfd = epoll_create1(0);
    struct epoll_event ev;
    ev.events = EPOLLIN;
    ev.data.fd = server_fd;
    epoll_ctl(epfd, EPOLL_CTL_ADD, server_fd, &ev);

    struct epoll_event events[64];

    while (1) {
        int n = epoll_wait(epfd, events, 64, -1);

        for (int i = 0; i < n; i++) {
            int fd = events[i].data.fd;

            if (fd == server_fd) {
                struct sockaddr_in client;
                socklen_t len = sizeof(client);
                int conn = accept(server_fd, (struct sockaddr *)&client, &len);
                set_nonblock(conn);
                ev.events = EPOLLIN | EPOLLET;
                ev.data.fd = conn;
                epoll_ctl(epfd, EPOLL_CTL_ADD, conn, &ev);

            } else if (events[i].events & EPOLLIN) {
                char buf[1024];
                ssize_t r = read(fd, buf, sizeof(buf));
                if (r <= 0) {
                    epoll_ctl(epfd, EPOLL_CTL_DEL, fd, NULL);
                    close(fd);
                } else {
                    write(fd, buf, r);
                }
            }
        }
    }

    close(epfd);
    close(server_fd);
    return 0;
}
```

这是 Nginx、Redis 事件循环的基本结构——一个线程用 epoll 管理成千上万个连接。

### Unix Domain Socket

同机器进程通信，用 Unix domain socket 比 TCP 快，接口几乎一样，只是地址换成文件路径：

```c
#include <sys/un.h>

int fd = socket(AF_UNIX, SOCK_STREAM, 0);

struct sockaddr_un addr = {};
addr.sun_family = AF_UNIX;
strcpy(addr.sun_path, "/tmp/myapp.sock");

unlink("/tmp/myapp.sock");
bind(fd, (struct sockaddr *)&addr, sizeof(addr));
listen(fd, 10);
// 后续和 TCP 完全一样
```

同机器进程通信优先考虑 Unix domain socket，不占端口，比 TCP 快。

---

这篇覆盖的内容在实际开发里是相互咬合的：进程用 `fork` + `exec` 起来，用信号通信，用 IPC 共享数据；文件 I/O 的 fd 模型贯穿始终，管道、socket、设备文件本质上都是 fd；网络编程建立在 socket 上，高并发靠 epoll，而 epoll 又回到了 fd 的事件模型。

把这几块打通之后，Nginx 的事件循环、Redis 的单线程模型、嵌入式 Linux 的串口通信这类代码读起来就不会陌生了。
