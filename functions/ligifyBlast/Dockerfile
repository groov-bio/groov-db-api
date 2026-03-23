FROM public.ecr.aws/lambda/python:3.12

# Download diamond BLAST binary
RUN curl -L -o diamond-linux64.tar.gz https://github.com/bbuchfink/diamond/releases/download/v2.1.8/diamond-linux64.tar.gz && \
    python3 -c "import tarfile; tarfile.open('diamond-linux64.tar.gz').extractall('.')" && \
    mv diamond /usr/local/bin/ && \
    rm diamond-linux64.tar.gz

COPY ligify_blast.dmnd ${LAMBDA_TASK_ROOT}/
COPY ligifyBlast.py ${LAMBDA_TASK_ROOT}/

CMD ["ligifyBlast.lambda_handler"]
